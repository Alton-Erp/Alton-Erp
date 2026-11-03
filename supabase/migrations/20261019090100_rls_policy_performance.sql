-- =============================================================================
-- Phase 11: equivalent, faster SELECT policies on the high-volume tables.
--
-- private.has_permission(company_id, p) is true only when company_id is the
-- caller's one active company (is_active_member) AND a role grants p. So
--   private.has_permission(company_id, p)
-- is equivalent to
--   company_id = (select private.current_company_id())
--   and (select private.has_permission(private.current_company_id(), p))
-- The sub-selects are evaluated ONCE per query (init plans) instead of once per
-- row, and the company_id equality lets the planner use the existing
-- (company_id, date) indexes, so "latest 50 movements" no longer filters and
-- joins the whole ledger. Who can see what is unchanged (verified by the RLS,
-- isolation and readiness suites).
--
-- Re-runnable: each policy is dropped and recreated inside the migration's
-- transaction, so there is no moment with a missing or wider policy.
-- =============================================================================

drop policy if exists inventory_transactions_select on public.inventory_transactions;
create policy inventory_transactions_select on public.inventory_transactions for select to authenticated
  using (company_id = (select private.current_company_id())
         and (select private.has_permission(private.current_company_id(), 'inventory.read')));

drop policy if exists inventory_balances_select on public.inventory_balances;
create policy inventory_balances_select on public.inventory_balances for select to authenticated
  using (company_id = (select private.current_company_id())
         and (select private.has_permission(private.current_company_id(), 'inventory.read')));

drop policy if exists stock_reservations_select on public.stock_reservations;
create policy stock_reservations_select on public.stock_reservations for select to authenticated
  using (company_id = (select private.current_company_id())
         and (select private.has_permission(private.current_company_id(), 'inventory.read')));

drop policy if exists products_select on public.products;
create policy products_select on public.products for select to authenticated
  using (company_id = (select private.current_company_id())
         and (select private.has_permission(private.current_company_id(), 'products.read')));

drop policy if exists inventory_batches_select on public.inventory_batches;
create policy inventory_batches_select on public.inventory_batches for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission(private.current_company_id(), 'inventory.read'))
              or (select private.has_permission(private.current_company_id(), 'inventory_batch.read'))));

drop policy if exists warehouses_select on public.warehouses;
create policy warehouses_select on public.warehouses for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission(private.current_company_id(), 'inventory.read'))
              or (select private.has_permission(private.current_company_id(), 'inventory_warehouse.manage'))));

drop policy if exists inventory_locations_select on public.inventory_locations;
create policy inventory_locations_select on public.inventory_locations for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission(private.current_company_id(), 'inventory.read'))
              or (select private.has_permission(private.current_company_id(), 'inventory_location.manage'))));

drop policy if exists audit_logs_select_auditor on public.audit_logs;
create policy audit_logs_select_auditor on public.audit_logs for select to authenticated
  using (company_id is not null and company_id = (select private.current_company_id())
         and (select private.has_permission(private.current_company_id(), 'audit_logs.read')));
