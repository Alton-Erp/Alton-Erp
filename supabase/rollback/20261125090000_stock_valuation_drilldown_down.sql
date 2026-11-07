-- Rollback of 20261125090000_stock_valuation_drilldown.sql.
-- Removes the read-only views and the summary function. No data is stored by that
-- migration, so nothing is lost; stock balances, transactions and costs are untouched.
-- Deploy the previous frontend first (the Total Stock drill-down reads these objects).

drop function if exists public.inventory_stock_value_summary(text, text);
drop view if exists public.inventory_product_stock_value;
drop view if exists public.inventory_balance_value;
