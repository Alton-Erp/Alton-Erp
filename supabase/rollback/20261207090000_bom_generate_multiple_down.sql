-- =============================================================================
-- Rollback of 20261207090000_bom_generate_multiple.sql
--
-- Drops the function. BOMs and products already generated through it are ordinary draft BOMs / products and stay.
-- Roll back the app's Generate Multiple page first (it calls this function for rows that are existing products).
-- =============================================================================

drop function if exists public.bom_generate_multiple(jsonb, jsonb, uuid);
