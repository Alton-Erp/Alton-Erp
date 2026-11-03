-- =============================================================================
-- ROLLBACK of 20261031090000_erp_force_reset.sql  (manual use only)
--
-- Removes the force reset: restores the eleven guard functions to their exact
-- previous bodies (no exemption), drops the force-reset functions and the
-- private approval / ticket / purge-session tables, and restores the standard
-- reset table list (without demo_presentation_data). Undeploy the Edge
-- Function too:  supabase functions delete force-reset-erp-data
--
-- KEPT on purpose (history): public.erp_reset_runs with its new columns
-- (mode, approval_id, backup_id, storage_objects) and
-- public.erp_reset_backup_attestations (append-only). The standard reset keeps
-- classifying erp_reset_backup_attestations as a kept table.
--
-- It does NOT bring back data deleted by a completed force reset (restore the
-- backup for that). Not in supabase/migrations, so it is never applied
-- automatically. Roll this back BEFORE rolling back 20261030090000.
-- =============================================================================

begin;

-- 1. Public and private force-reset functions.
drop function if exists public.erp_force_reset_preview(uuid);
drop function if exists public.erp_force_reset_record_backup(uuid, text, text, timestamptz, boolean, boolean, text);
drop function if exists public.erp_force_reset_issue_ticket(uuid, uuid);
drop function if exists public.erp_force_reset_execute(uuid, uuid, text, text, uuid, text);
drop function if exists public.erp_force_reset_record_failure(uuid, uuid, uuid, text);
drop function if exists public.erp_force_reset_record_storage_cleanup(uuid, uuid, int, int, text);
drop function if exists public.erp_force_reset_verify(uuid, uuid);
drop function if exists private.erp_force_reset_run_result(public.erp_reset_runs, boolean);
drop function if exists private.erp_force_reset_approve(text, uuid, text, text, text, int);
drop function if exists private.erp_force_reset_revoke_approval(uuid, text);
drop function if exists private.erp_force_reset_plan(uuid);
drop function if exists private.erp_force_reset_super_admins(uuid);
drop function if exists private.erp_force_reset_valid_backup(uuid, uuid);
drop function if exists private.erp_force_reset_active_approval(uuid);
drop function if exists private.erp_force_reset_storage_objects(uuid);
drop function if exists private.erp_force_reset_counts(uuid);
drop function if exists private.erp_force_reset_guarded_tables();
drop function if exists private.erp_force_reset_order();
drop function if exists private.erp_force_reset_self_fk_clause(text);
drop function if exists private.erp_force_reset_row_filter(text);
drop function if exists private.erp_force_reset_retained_tables();

-- 2. Guards: exact bodies from the original migrations.
create or replace function private.prevent_ledger_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Posted stock transactions cannot be changed or deleted. Post a reversal instead.' using errcode = '42501';
end;
$$;

create or replace function private.prevent_history_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'History records cannot be changed or deleted.' using errcode = '42501';
end;
$$;

create or replace function private.prevent_import_history_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Import history is append-only.' using errcode = '42501';
end;
$$;

create or replace function private.prevent_approval_decision_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Approval decisions are append-only.' using errcode = '42501';
end;
$$;

create or replace function private.guard_posted_document()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mutable text[] := array['status', 'reversal_transaction_ids', 'reversal_reason', 'reversed_by', 'reversed_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'Posted records cannot be deleted. Reverse them instead.' using errcode = '42501';
  end if;
  if old.status <> 'POSTED' or new.status <> 'REVERSED'
     or (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception 'Posted records cannot be changed; only a single reversal is allowed.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function private.guard_bom_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'BOMs are never deleted; archive them instead.' using errcode = '42501';
  end if;
  new.company_id := old.company_id;
  new.bom_code := old.bom_code;
  new.finished_product_id := old.finished_product_id;
  new.version := old.version;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  if old.status in ('APPROVED', 'ARCHIVED')
     and (new.effective_from is distinct from old.effective_from
          or new.output_quantity is distinct from old.output_quantity
          or new.output_unit is distinct from old.output_unit
          or new.notes is distinct from old.notes
          or new.approved_by is distinct from old.approved_by) then
    raise exception 'An approved BOM cannot be changed. Create a new version instead.' using errcode = 'P0001';
  end if;
  if old.status = 'ARCHIVED' and new.status <> 'ARCHIVED' then
    raise exception 'An archived BOM cannot be reactivated. Create a new version instead.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function private.guard_bom_item_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status from public.boms where id = coalesce(new.bom_id, old.bom_id);
  if v_status not in ('DRAFT', 'REJECTED') then
    raise exception 'Components of a % BOM cannot be changed. Create a new version instead.', lower(v_status) using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function private.guard_invoice_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Invoices are never deleted. Discard a draft or cancel an issued invoice.' using errcode = 'P0001';
  end if;
  if old.status in ('CANCELLED', 'DISCARDED') then
    raise exception 'A % invoice cannot be changed.', lower(old.status) using errcode = 'P0001';
  end if;
  if old.status = 'ISSUED' then
    if new.status <> 'CANCELLED'
       or (to_jsonb(new) - array['status', 'cancelled_by', 'cancelled_at', 'cancellation_reason', 'updated_at', 'updated_by'])
          is distinct from (to_jsonb(old) - array['status', 'cancelled_by', 'cancelled_at', 'cancellation_reason', 'updated_at', 'updated_by']) then
      raise exception 'Issued invoice % cannot be edited. Use a credit or debit note, or cancel it through the approved workflow.', old.invoice_number
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.guard_invoice_line_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status from public.sales_invoices where id = coalesce(new.invoice_id, old.invoice_id);
  -- Drafts are edited; invoices pending approval are only recalculated at issue.
  if v_status is null or v_status not in ('DRAFT', 'PENDING_APPROVAL') then
    raise exception 'Lines of a % invoice cannot be changed.', replace(lower(coalesce(v_status, 'unknown')), '_', ' ') using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function private.guard_payment_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Payment records are never deleted; reverse them instead.' using errcode = 'P0001';
  end if;
  if tg_table_name = 'customer_payments' then
    if old.status <> 'RECORDED' or new.status <> 'REVERSED'
       or (to_jsonb(new) - array['status', 'reversal_reason', 'reversed_by', 'reversed_at']) is distinct from (to_jsonb(old) - array['status', 'reversal_reason', 'reversed_by', 'reversed_at']) then
      raise exception 'A recorded receipt cannot be edited; reverse it and record a new one.' using errcode = 'P0001';
    end if;
  else
    if old.status <> 'ACTIVE' or new.status <> 'REVERSED'
       or (to_jsonb(new) - array['status', 'reversal_reason', 'reversed_by', 'reversed_at']) is distinct from (to_jsonb(old) - array['status', 'reversal_reason', 'reversed_by', 'reversed_at']) then
      raise exception 'A payment allocation cannot be edited; reverse it and allocate again.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.guard_note_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if tg_table_name = 'invoice_adjustment_notes' then
    if tg_op = 'DELETE' then
      raise exception 'Credit and debit notes are never deleted.' using errcode = 'P0001';
    end if;
    if old.status in ('CANCELLED', 'DISCARDED') then
      raise exception 'A % note cannot be changed.', lower(old.status) using errcode = 'P0001';
    end if;
    if old.status = 'ISSUED' and (new.status <> 'CANCELLED'
       or (to_jsonb(new) - array['status', 'cancelled_by', 'cancelled_at', 'cancellation_reason', 'updated_at'])
          is distinct from (to_jsonb(old) - array['status', 'cancelled_by', 'cancelled_at', 'cancellation_reason', 'updated_at'])) then
      raise exception 'Issued note % cannot be edited; issue a new note instead.', old.note_number using errcode = 'P0001';
    end if;
    return new;
  end if;
  select status into v_status from public.invoice_adjustment_notes where id = coalesce(new.note_id, old.note_id);
  if v_status is null or v_status not in ('DRAFT', 'PENDING_APPROVAL') then
    raise exception 'Lines of a % note cannot be changed.', lower(coalesce(v_status, 'unknown')) using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;

-- 3. The exemption check and the force-reset table list (no longer referenced).
drop function if exists private.erp_force_purge_allows(text, uuid);
drop function if exists private.erp_force_reset_tables();

-- 4. Private state.
drop table if exists private.erp_force_purge_sessions;
drop table if exists private.erp_force_reset_tickets;
drop table if exists private.erp_force_reset_approvals;   -- approvals are also recorded in audit_logs

-- 5. Standard reset list as in 20261030090000 (75 tables, no demo_presentation_data).
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    -- 0: leaf records
    (0, 'amazon_ad_change_requests', 'Amazon', 'Amazon ad change requests'),
    (0, 'amazon_ad_groups', 'Amazon', 'Amazon ad groups'),
    (0, 'amazon_ad_product_daily', 'Amazon', 'Amazon advertised-product daily data'),
    (0, 'amazon_budget_plans', 'Amazon', 'Amazon budget plans'),
    (0, 'amazon_campaign_daily', 'Amazon', 'Amazon campaign daily data'),
    (0, 'amazon_campaigns', 'Amazon', 'Amazon campaigns'),
    (0, 'amazon_inventory_snapshots', 'Amazon', 'Amazon inventory snapshots'),
    (0, 'amazon_listings', 'Amazon', 'Amazon listings'),
    (0, 'amazon_search_term_daily', 'Amazon', 'Amazon search-term daily data'),
    (0, 'amazon_sku_daily', 'Amazon', 'Amazon SKU daily sales'),
    (0, 'amazon_sync_errors', 'Amazon', 'Amazon sync errors'),
    (0, 'amazon_targets', 'Amazon', 'Amazon targets'),
    (0, 'approval_decisions', 'Approvals, notifications & imports', 'Approval decisions'),
    (0, 'billing_events', 'Billing & receivables', 'Billing history'),
    (0, 'bom_items', 'Production & BOMs', 'BOM components'),
    (0, 'customer_po_allocation_runs', 'Customer purchase orders', 'Customer PO allocation runs'),
    (0, 'customer_po_analysis_snapshots', 'Customer purchase orders', 'Customer PO analysis snapshots'),
    (0, 'customer_po_events', 'Customer purchase orders', 'Customer PO history'),
    (0, 'customer_po_shortage_notes', 'Customer purchase orders', 'Customer PO shortage notes'),
    (0, 'customer_product_codes', 'Customers & suppliers', 'Customer product codes'),
    (0, 'customer_return_lines', 'Sales & fulfilment', 'Customer return lines'),
    (0, 'delivery_events', 'Sales & fulfilment', 'Delivery history'),
    (0, 'goods_receipt_lines', 'Supplier purchasing', 'Goods receipt lines'),
    (0, 'import_job_rows', 'Approvals, notifications & imports', 'Import rows'),
    (0, 'inventory_adjustments', 'Inventory', 'Stock adjustments'),
    (0, 'inventory_alerts', 'Inventory', 'Stock alerts'),
    (0, 'inventory_balances', 'Inventory', 'Stock balances'),
    (0, 'inventory_count_lines', 'Inventory', 'Stock count lines'),
    (0, 'inventory_opening_lines', 'Inventory', 'Opening stock lines'),
    (0, 'inventory_requests', 'Inventory', 'Stock operation requests'),
    (0, 'invoice_adjustment_note_lines', 'Billing & receivables', 'Credit / debit note lines'),
    (0, 'invoice_payment_allocations', 'Billing & receivables', 'Payment allocations'),
    (0, 'notifications', 'Approvals, notifications & imports', 'Notifications'),
    (0, 'outsourcing_material_movements', 'Outsourcing', 'Outsourcing material movements'),
    (0, 'outsourcing_order_events', 'Outsourcing', 'Outsourcing history'),
    (0, 'production_material_consumption', 'Production & BOMs', 'Material issues'),
    (0, 'production_order_events', 'Production & BOMs', 'Production history'),
    (0, 'production_output_receipts', 'Production & BOMs', 'Production output'),
    (0, 'purchase_order_amendments', 'Supplier purchasing', 'Purchase order amendments'),
    (0, 'purchase_order_events', 'Supplier purchasing', 'Purchase order history'),
    (0, 'purchase_order_import_refs', 'Supplier purchasing', 'Purchase order import references'),
    (0, 'sales_invoice_dispatch_allocations', 'Billing & receivables', 'Invoice dispatch allocations'),
    (0, 'sales_order_events', 'Sales & fulfilment', 'Sales order history'),
    -- 1
    (1, 'amazon_recommendations', 'Amazon', 'Amazon recommendations'),
    (1, 'amazon_sync_jobs', 'Amazon', 'Amazon sync jobs'),
    (1, 'approval_requests', 'Approvals, notifications & imports', 'Approval requests'),
    (1, 'customer_payments', 'Billing & receivables', 'Customer payments'),
    (1, 'goods_receipts', 'Supplier purchasing', 'Goods receipts'),
    (1, 'import_jobs', 'Approvals, notifications & imports', 'Import jobs'),
    (1, 'inventory_counts', 'Inventory', 'Stock counts'),
    (1, 'inventory_opening_batches', 'Inventory', 'Opening stock documents'),
    (1, 'invoice_adjustment_notes', 'Billing & receivables', 'Credit / debit notes'),
    (1, 'outsourcing_order_materials', 'Outsourcing', 'Outsourcing material plans'),
    (1, 'outsourcing_receipts', 'Outsourcing', 'Outsourcing receipts'),
    (1, 'production_order_materials', 'Production & BOMs', 'Production material plans'),
    (1, 'purchase_order_lines', 'Supplier purchasing', 'Purchase order lines'),
    (1, 'sales_invoice_lines', 'Billing & receivables', 'Invoice lines'),
    -- 2
    (2, 'customer_returns', 'Sales & fulfilment', 'Customer returns'),
    (2, 'fulfilment_lines', 'Sales & fulfilment', 'Fulfilment lines'),
    (2, 'outsourcing_orders', 'Outsourcing', 'Outsourcing orders'),
    (2, 'production_orders', 'Production & BOMs', 'Production orders'),
    (2, 'purchase_orders', 'Supplier purchasing', 'Supplier purchase orders'),
    (2, 'sales_invoices', 'Billing & receivables', 'Sales invoices'),
    -- 3
    (3, 'boms', 'Production & BOMs', 'Bills of materials'),
    (3, 'fulfilments', 'Sales & fulfilment', 'Fulfilments and dispatches'),
    (3, 'inventory_transactions', 'Inventory', 'Stock ledger'),
    (3, 'sales_order_lines', 'Sales & fulfilment', 'Sales order lines'),
    (3, 'stock_reservations', 'Inventory', 'Stock reservations'),
    (3, 'suppliers', 'Customers & suppliers', 'Suppliers'),
    -- 4
    (4, 'customer_purchase_order_lines', 'Customer purchase orders', 'Customer PO lines'),
    (4, 'inventory_batches', 'Inventory', 'Stock batches / lots'),
    (4, 'sales_orders', 'Sales & fulfilment', 'Sales orders'),
    -- 5
    (5, 'customer_purchase_orders', 'Customer purchase orders', 'Customer purchase orders'),
    -- 6
    (6, 'customer_po_import_batches', 'Customer purchase orders', 'Customer PO import batches'),
    (6, 'customers', 'Customers & suppliers', 'Customers')
  ) t (ord, table_name, category, label);
$$;

revoke all on function private.erp_reset_tables() from public, anon, authenticated;

commit;
