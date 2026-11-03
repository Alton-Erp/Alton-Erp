-- =============================================================================
-- ROLLBACK of 20261030090000_erp_reset.sql  (manual use only)
--
-- Removes the ERP reset: its functions and the system.reset_data permission.
-- After this the reset-erp-data Edge Function cannot run a reset (the database
-- functions it calls no longer exist); undeploy it too:
--   supabase functions delete reset-erp-data
--
-- It does NOT bring back data deleted by a completed reset (restore a backup
-- for that) and it KEEPS public.erp_reset_runs, the history of reset attempts
-- (append-only; the same events are also in audit_logs). Drop that table only
-- if you are sure the history is not needed (statement at the end, commented).
-- Not in supabase/migrations on purpose, so it is never applied automatically.
-- =============================================================================

begin;

drop function if exists public.erp_reset_execute(uuid, uuid, text);
drop function if exists public.erp_reset_verify(uuid);
drop function if exists public.erp_reset_record_attempt(uuid, text);
drop function if exists public.erp_reset_attempt_allowed(uuid);
drop function if exists public.erp_reset_preview();
drop function if exists private.erp_reset_plan(uuid);
drop function if exists private.erp_reset_counts(uuid);
drop function if exists private.erp_reset_kept_supplier_count(uuid);
drop function if exists private.erp_reset_actor_ok(uuid, uuid);
drop function if exists private.erp_reset_schema_fingerprint();
drop function if exists private.erp_reset_guarded_tables();
drop function if exists private.erp_reset_guard_reason(text);
drop function if exists private.erp_reset_document_entity_types();
drop function if exists private.erp_reset_kept_tables();
drop function if exists private.erp_reset_tables();

-- The permission (its role grants go with it).
delete from public.permissions where code = 'system.reset_data';

commit;

-- Optional, irreversible: removes the reset history table.
-- drop table if exists public.erp_reset_runs;
