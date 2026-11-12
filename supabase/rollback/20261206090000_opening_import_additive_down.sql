-- =============================================================================
-- Rollback of 20261206090000_opening_import_additive.sql
--
-- Drops the import function and the matching read function. Nothing else was changed by the migration.
-- KEPT: quantities already added by imports are ordinary posted stock movements (transaction type
-- OPENING_STOCK, reference_type OPENING_ADDITION) with their audit entries; they stay in the ledger.
-- Roll back the app's opening stock import first: it calls these functions.
-- =============================================================================

drop function if exists public.inventory_import_opening_stock(jsonb, jsonb, boolean, text, text, uuid);
drop function if exists public.opening_stock_import_matches(uuid[]);
drop function if exists private.opening_added_quantity(uuid);
drop function if exists private.opening_addition_cost_error(uuid, numeric, numeric, text);
