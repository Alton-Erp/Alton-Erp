-- =============================================================================
-- Department-wise Data Management (Settings → ERP Settings → System)
--
-- Approved plan: docs/DEPARTMENT_DATA_MANAGEMENT_PLAN.md (decisions D1–D7).
--
-- Seven departments, each with categories of three kinds:
--   ARCHIVE  sets the existing inactive / archived state (nothing deleted; reversible)
--   RESET    deletes transient working data (resolved alerts, old request ids, closed reservations)
--   DELETE   permanently deletes never-used master records and unposted / cancelled documents
--            (with their own history rows), never anything posted
--
-- Safety (all enforced here, in the database):
--   * Super Admin with system.reset_data, own company only (company from the profile, never the request)
--   * one planner for preview and execution; the execution stops if the plan changed (plan hash)
--   * one transaction; any error rolls back every change; the attempt is still recorded
--   * explicit id lists per table, in dependency order; no cascades; RLS and foreign keys unchanged
--   * a record referenced by anything outside the plan (any foreign key, posted stock movement,
--     reservation, pending approval, production order for a sales order, invoice for a sales order)
--     is blocked and shown in the preview with the reason
--   * posted stock, production, purchase, sales, invoice, note, payment and ledger history is never
--     in any plan (decisions D1 and D2)
--   * DELETE needs: typed phrase, a backup record of the last 24 h made by the same Super Admin
--     (erp_reset_backup_attestations, single use), and a password sign-in in the last 5 minutes
--     (checked from the session token's amr claim)
--   * history rows of the planned documents only may be deleted (D4): each guard trigger accepts a
--     delete only for a row registered in the running call's session (company, transaction, table, id)
--   * every attempt: erp_reset_runs (mode DEPARTMENT) and audit_logs; both append-only
--
-- Additive only. Rollback: supabase/rollback/20261119090000_department_data_management_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Run history: department runs (columns are new and nullable; existing rows unchanged)
-- -----------------------------------------------------------------------------
alter table public.erp_reset_runs add column if not exists department text;
alter table public.erp_reset_runs add column if not exists operation text;
alter table public.erp_reset_runs add column if not exists categories text[];
alter table public.erp_reset_runs add column if not exists plan_hash text;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'erp_reset_runs_mode_check' and conrelid = 'public.erp_reset_runs'::regclass
             and pg_get_constraintdef(oid) not like '%DEPARTMENT%') then
    alter table public.erp_reset_runs drop constraint erp_reset_runs_mode_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'erp_reset_runs_mode_check' and conrelid = 'public.erp_reset_runs'::regclass) then
    alter table public.erp_reset_runs add constraint erp_reset_runs_mode_check check (mode in ('STANDARD', 'FORCE', 'DEPARTMENT'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'erp_reset_runs_department_check' and conrelid = 'public.erp_reset_runs'::regclass) then
    alter table public.erp_reset_runs add constraint erp_reset_runs_department_check check (
      (mode = 'DEPARTMENT') = (department is not null)
      and (department is null or department in ('PRODUCTS', 'INVENTORY', 'PURCHASE', 'PRODUCTION', 'SALES', 'BILLING', 'LEDGER'))
      and (operation is null or operation in ('ARCHIVE', 'RESET', 'DELETE')));
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 2. Session exemption for the delete guards (rows of the running call only)
-- -----------------------------------------------------------------------------
create table if not exists private.dept_purge_sessions (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  actor      uuid not null,
  request_id uuid not null,
  txid       bigint not null,
  created_at timestamptz not null default now()
);
create table if not exists private.dept_purge_rows (
  session_id uuid not null references private.dept_purge_sessions (id) on delete cascade,
  table_name text not null,
  row_key    text not null,
  primary key (session_id, table_name, row_key)
);
revoke all on private.dept_purge_sessions, private.dept_purge_rows from public, anon, authenticated;

-- True only inside department_data_execute's own transaction, for a planned row of that company.
create or replace function private.dept_purge_allows(p_table text, p_company uuid, p_key text)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select p_company is not null and p_key is not null
    and coalesce(current_setting('app.dept_purge', true), '') <> ''
    and exists (select 1 from private.dept_purge_sessions s
                join private.dept_purge_rows r on r.session_id = s.id
                where s.id::text = current_setting('app.dept_purge', true)
                  and s.company_id = p_company and s.txid = txid_current()
                  and r.table_name = p_table and r.row_key = p_key);
$$;
revoke all on function private.dept_purge_allows(text, uuid, text) from public, anon;
-- Guard triggers run as the role issuing the statement; this only ever returns true inside a session.
grant execute on function private.dept_purge_allows(text, uuid, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Departments and categories
-- -----------------------------------------------------------------------------
create or replace function private.dept_categories()
returns table (department text, code text, operation text, label text, description text, sort int)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('PRODUCTS', 'products.archive_inactive', 'ARCHIVE', 'Archive inactive products', 'Inactive products that are not archived yet are archived (hidden from lists; restorable).', 1),
    ('PRODUCTS', 'products.unused_products', 'DELETE', 'Never-used inactive products', 'Inactive products with no stock, order, BOM, invoice or any other record, with their version history.', 2),
    ('PRODUCTS', 'products.unused_categories', 'DELETE', 'Unused inactive categories', 'Inactive product categories with no product.', 3),
    ('PRODUCTS', 'products.draft_boms', 'DELETE', 'Draft and rejected BOM versions', 'BOM versions that were never approved and are not used by any production or outsourcing order.', 4),
    ('INVENTORY', 'inventory.archive_empty_warehouses', 'ARCHIVE', 'Deactivate empty warehouses', 'Active warehouses (not the default) with no stock and no open document.', 1),
    ('INVENTORY', 'inventory.resolved_alerts', 'RESET', 'Resolved stock alerts', 'Alerts already resolved (open and acknowledged alerts are kept).', 2),
    ('INVENTORY', 'inventory.old_request_ids', 'RESET', 'Old request ids', 'Duplicate-protection ids of stock operations older than 7 days.', 3),
    ('INVENTORY', 'inventory.closed_reservations', 'RESET', 'Released and expired reservations', 'Reservations that were released, cancelled or expired and not used by a dispatch.', 4),
    ('INVENTORY', 'inventory.unposted_documents', 'DELETE', 'Unposted adjustments, counts and opening stock', 'Draft, rejected and cancelled adjustments, stock counts and opening stock that never moved stock.', 5),
    ('INVENTORY', 'inventory.unused_warehouses', 'DELETE', 'Never-used inactive warehouses', 'Inactive warehouses whose locations were never used, with those locations.', 6),
    ('PURCHASE', 'purchase.unposted_orders', 'DELETE', 'Draft and cancelled purchase orders', 'Draft and cancelled purchase orders with no goods received, with their lines and history.', 1),
    ('PRODUCTION', 'production.unposted_orders', 'DELETE', 'Draft and cancelled production orders', 'Draft and cancelled production orders with no consumption, output or open reservation, with their materials and history.', 1),
    ('PRODUCTION', 'production.unposted_outsourcing', 'DELETE', 'Draft and cancelled outsourcing orders', 'Draft and cancelled outsourcing orders with no material movement or receipt, with their materials and history.', 2),
    ('SALES', 'sales.unposted_orders', 'DELETE', 'Draft and cancelled sales orders', 'Draft and cancelled sales orders with no dispatch, return, invoice, production order or open reservation, with their lines and history.', 1),
    ('SALES', 'sales.customer_product_codes', 'DELETE', 'Customer product codes', 'Customer-specific product codes used to match imported orders.', 2),
    ('SALES', 'sales.legacy_customer_pos', 'DELETE', 'Legacy customer purchase orders', 'Customer POs of the earlier module that no sales order uses, with their lines and history.', 3),
    ('BILLING', 'billing.draft_invoices', 'DELETE', 'Draft and discarded invoices', 'Invoices that were never issued and have no number (no proforma), with their lines and history.', 1),
    ('BILLING', 'billing.draft_notes', 'DELETE', 'Draft and discarded credit / debit notes', 'Credit and debit notes that were never issued, with their lines and history.', 2),
    ('LEDGER', 'ledger.archive_dormant', 'ARCHIVE', 'Deactivate dormant customers and suppliers', 'Active customers and suppliers with no open order, nothing outstanding and a zero balance.', 1),
    ('LEDGER', 'ledger.unused_parties', 'DELETE', 'Never-used inactive customers and suppliers', 'Inactive customers and suppliers with no document, payment or opening balance, with their ledger party.', 2)
  ) t (department, code, operation, label, description, sort);
$$;

-- Deletion order: dependants first (lower runs first).
create or replace function private.dept_table_ord(p_table text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case
    when p_table in ('purchase_order_events', 'purchase_order_amendments', 'purchase_order_import_refs', 'purchase_document_refs',
                     'production_order_events', 'production_order_requests', 'production_order_revisions', 'outsourcing_order_events',
                     'sales_order_events', 'billing_events', 'customer_po_events', 'customer_po_allocation_runs', 'customer_po_analysis_snapshots',
                     'customer_po_shortage_notes', 'sales_invoice_dispatch_allocations', 'invoice_adjustment_note_lines', 'inventory_count_lines',
                     'inventory_opening_lines', 'bom_items', 'notifications', 'erp_form_drafts', 'inventory_alerts', 'inventory_requests',
                     'customer_product_codes') then 0
    when p_table in ('purchase_order_lines', 'production_order_materials', 'outsourcing_order_materials', 'sales_invoice_lines',
                     'invoice_adjustment_notes', 'inventory_counts', 'inventory_opening_batches', 'inventory_adjustments', 'stock_reservations',
                     'customer_purchase_order_lines') then 1
    when p_table in ('sales_order_lines') then 2
    when p_table in ('purchase_orders', 'production_orders', 'outsourcing_orders', 'sales_invoices', 'sales_orders', 'boms') then 3
    when p_table in ('customer_purchase_orders', 'product_versions', 'inventory_locations', 'parties') then 4
    when p_table in ('customer_po_import_batches', 'products', 'warehouses', 'customers', 'suppliers') then 5
    when p_table in ('product_categories') then 6
  end;
$$;

-- Key column of a table (text form); every other planned table uses id.
create or replace function private.dept_key_col(p_table text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_table when 'production_order_requests' then 'production_order_id' when 'inventory_requests' then 'idempotency_key' else 'id' end;
$$;

-- Department of a table (affected departments in the preview).
create or replace function private.dept_of_table(p_table text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_table in ('products', 'product_categories', 'product_versions', 'boms', 'bom_items') then 'PRODUCTS'
    when p_table in ('warehouses', 'inventory_locations', 'inventory_batches', 'inventory_balances', 'inventory_transactions', 'inventory_adjustments',
                     'inventory_counts', 'inventory_count_lines', 'inventory_opening_batches', 'inventory_opening_lines', 'stock_reservations',
                     'inventory_alerts', 'inventory_requests') then 'INVENTORY'
    when p_table in ('purchase_orders', 'purchase_order_lines', 'purchase_order_events', 'purchase_order_amendments', 'purchase_order_import_refs',
                     'purchase_document_refs', 'goods_receipts', 'goods_receipt_lines') then 'PURCHASE'
    when p_table like 'production\_%' or p_table like 'outsourcing\_%' then 'PRODUCTION'
    when p_table in ('sales_orders', 'sales_order_lines', 'sales_order_events', 'fulfilments', 'fulfilment_lines', 'delivery_events', 'customer_returns',
                     'customer_return_lines', 'customer_product_codes') or p_table like 'customer\_po%' or p_table like 'customer\_purchase\_order%' then 'SALES'
    when p_table in ('sales_invoices', 'sales_invoice_lines', 'sales_invoice_dispatch_allocations', 'invoice_adjustment_notes', 'invoice_adjustment_note_lines',
                     'customer_payments', 'invoice_payment_allocations', 'billing_events') then 'BILLING'
    when p_table in ('parties', 'customers', 'suppliers', 'supplier_payments') then 'LEDGER'
    else 'OTHER'
  end;
$$;

-- A readable reference of a row (document number, SKU, code ...).
create or replace function private.dept_row_label(p_table text, p_key text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  j jsonb;
begin
  execute format('select to_jsonb(t) from public.%I t where t.%I::text = $1 limit 1', p_table, private.dept_key_col(p_table)) into j using p_key;
  return coalesce(j ->> 'po_number', j ->> 'sales_order_number', j ->> 'production_order_number', j ->> 'outsourcing_order_number',
    j ->> 'invoice_number', j ->> 'proforma_number', j ->> 'note_number', j ->> 'adjustment_number', j ->> 'count_number', j ->> 'receipt_number',
    j ->> 'transaction_number', j ->> 'reservation_number', j ->> 'customer_po_number', (j ->> 'bom_code') || ' v' || (j ->> 'version'),
    case when j ? 'sku' then (j ->> 'sku') || coalesce(' — ' || (j ->> 'product_name'), '') end,
    j ->> 'warehouse_code', j ->> 'location_code', j ->> 'customer_code', j ->> 'supplier_code', j ->> 'party_code', j ->> 'batch_number', j ->> 'name',
    case when j ? 'status' then initcap(replace(j ->> 'status', '_', ' ')) || ' ' || left(p_key, 8) end, left(p_key, 8));
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. The planner (shared by preview and execution)
-- -----------------------------------------------------------------------------
-- Fills pg_temp.dept_plan (rows to change, with the root document they belong to) and
-- pg_temp.dept_blocked (roots that cannot be changed, with the reason). Returns a summary.
create or replace function private.dept_plan(p_company uuid, p_department text, p_operation text, p_categories text[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cats   text[];
  v_changed boolean;
  v_round  int := 0;
  v_hash   text;
  v_tables jsonb;
  v_result jsonb;
  fk       record;
  v_hits   bigint;
  v_join   text;
  v_ckey   text;
  i        int;
begin
  create temp table if not exists dept_plan (category text not null, root_table text not null, root_key text not null,
    table_name text not null, row_key text not null, primary key (table_name, row_key));
  create temp table if not exists dept_blocked (category text not null, root_table text not null, root_key text not null,
    reason text not null, ref_table text, ref_key text);
  truncate pg_temp.dept_plan, pg_temp.dept_blocked;

  select coalesce(array_agg(c.code order by c.sort), '{}') into v_cats from private.dept_categories() c
  where c.department = p_department and c.operation = p_operation and (p_categories is null or c.code = any (p_categories));

  -- ---- Candidate roots and their own rows -------------------------------------------------
  -- Product Master & BOM
  if 'products.archive_inactive' = any (v_cats) then
    -- A product that still has stock cannot be archived (guard_product_inventory): listed as blocked.
    insert into pg_temp.dept_plan select 'products.archive_inactive', 'products', p.id::text, 'products', p.id::text
    from public.products p where p.company_id = p_company and p.status = 'INACTIVE' and p.archived_at is null
      and not exists (select 1 from public.inventory_balances b where b.product_id = p.id and (b.on_hand <> 0 or b.reserved <> 0));
    insert into pg_temp.dept_blocked (category, root_table, root_key, reason, ref_table, ref_key)
    select 'products.archive_inactive', 'products', p.id::text, 'Still has stock', null, null
    from public.products p where p.company_id = p_company and p.status = 'INACTIVE' and p.archived_at is null
      and exists (select 1 from public.inventory_balances b where b.product_id = p.id and (b.on_hand <> 0 or b.reserved <> 0));
  end if;
  if 'products.unused_products' = any (v_cats) then
    insert into pg_temp.dept_plan select 'products.unused_products', 'products', id::text, 'products', id::text
    from public.products where company_id = p_company and status = 'INACTIVE';
    insert into pg_temp.dept_plan select 'products.unused_products', 'products', v.product_id::text, 'product_versions', v.id::text
    from public.product_versions v join pg_temp.dept_plan p on p.table_name = 'products' and p.row_key = v.product_id::text
    where v.company_id = p_company on conflict do nothing;
  end if;
  if 'products.unused_categories' = any (v_cats) then
    insert into pg_temp.dept_plan select 'products.unused_categories', 'product_categories', id::text, 'product_categories', id::text
    from public.product_categories where company_id = p_company and not is_active;
  end if;
  if 'products.draft_boms' = any (v_cats) then
    insert into pg_temp.dept_plan select 'products.draft_boms', 'boms', id::text, 'boms', id::text
    from public.boms where company_id = p_company and status in ('DRAFT', 'REJECTED');
    insert into pg_temp.dept_plan select 'products.draft_boms', 'boms', i.bom_id::text, 'bom_items', i.id::text
    from public.bom_items i join pg_temp.dept_plan p on p.table_name = 'boms' and p.row_key = i.bom_id::text where i.company_id = p_company;
  end if;

  -- Inventory
  if 'inventory.archive_empty_warehouses' = any (v_cats) then
    insert into pg_temp.dept_plan select 'inventory.archive_empty_warehouses', 'warehouses', w.id::text, 'warehouses', w.id::text
    from public.warehouses w
    where w.company_id = p_company and w.status = 'ACTIVE' and not w.is_default
      and not exists (select 1 from public.inventory_balances b join public.inventory_locations l on l.id = b.location_id
                      where l.warehouse_id = w.id and (b.on_hand <> 0 or b.reserved <> 0))
      and not exists (select 1 from public.purchase_orders o where o.warehouse_id = w.id and o.status not in ('RECEIVED', 'CLOSED', 'CANCELLED'))
      and not exists (select 1 from public.sales_orders o where o.warehouse_id = w.id and o.order_status not in ('FULFILLED', 'CANCELLED'))
      and not exists (select 1 from public.production_orders o where w.id in (o.source_warehouse_id, o.destination_warehouse_id) and o.status not in ('COMPLETED', 'CANCELLED'))
      and not exists (select 1 from public.outsourcing_orders o where o.destination_warehouse_id = w.id and o.status not in ('COMPLETED', 'CANCELLED'))
      and not exists (select 1 from public.inventory_counts c where c.warehouse_id = w.id and c.status in ('OPEN', 'SUBMITTED'));
  end if;
  if 'inventory.resolved_alerts' = any (v_cats) then
    insert into pg_temp.dept_plan select 'inventory.resolved_alerts', 'inventory_alerts', id::text, 'inventory_alerts', id::text
    from public.inventory_alerts where company_id = p_company and status = 'RESOLVED';
  end if;
  if 'inventory.old_request_ids' = any (v_cats) then
    insert into pg_temp.dept_plan select 'inventory.old_request_ids', 'inventory_requests', idempotency_key, 'inventory_requests', idempotency_key
    from public.inventory_requests where company_id = p_company and created_at < now() - interval '7 days';
  end if;
  if 'inventory.closed_reservations' = any (v_cats) then
    insert into pg_temp.dept_plan select 'inventory.closed_reservations', 'stock_reservations', id::text, 'stock_reservations', id::text
    from public.stock_reservations where company_id = p_company and reservation_status in ('RELEASED', 'CANCELLED', 'EXPIRED');
  end if;
  if 'inventory.unposted_documents' = any (v_cats) then
    insert into pg_temp.dept_plan select 'inventory.unposted_documents', 'inventory_adjustments', id::text, 'inventory_adjustments', id::text
    from public.inventory_adjustments where company_id = p_company and status in ('DRAFT', 'REJECTED', 'CANCELLED');
    insert into pg_temp.dept_plan select 'inventory.unposted_documents', 'inventory_opening_batches', id::text, 'inventory_opening_batches', id::text
    from public.inventory_opening_batches where company_id = p_company and status in ('REJECTED', 'CANCELLED');
    insert into pg_temp.dept_plan select 'inventory.unposted_documents', 'inventory_opening_batches', l.opening_batch_id::text, 'inventory_opening_lines', l.id::text
    from public.inventory_opening_lines l join pg_temp.dept_plan p on p.table_name = 'inventory_opening_batches' and p.row_key = l.opening_batch_id::text
    where l.company_id = p_company;
    insert into pg_temp.dept_plan select 'inventory.unposted_documents', 'inventory_counts', id::text, 'inventory_counts', id::text
    from public.inventory_counts where company_id = p_company and status in ('OPEN', 'REJECTED', 'CANCELLED');
    insert into pg_temp.dept_plan select 'inventory.unposted_documents', 'inventory_counts', l.count_id::text, 'inventory_count_lines', l.id::text
    from public.inventory_count_lines l join pg_temp.dept_plan p on p.table_name = 'inventory_counts' and p.row_key = l.count_id::text
    where l.company_id = p_company;
  end if;
  if 'inventory.unused_warehouses' = any (v_cats) then
    insert into pg_temp.dept_plan select 'inventory.unused_warehouses', 'warehouses', id::text, 'warehouses', id::text
    from public.warehouses where company_id = p_company and status = 'INACTIVE' and not is_default;
    insert into pg_temp.dept_plan select 'inventory.unused_warehouses', 'warehouses', l.warehouse_id::text, 'inventory_locations', l.id::text
    from public.inventory_locations l join pg_temp.dept_plan p on p.table_name = 'warehouses' and p.row_key = l.warehouse_id::text
    where l.company_id = p_company;
  end if;

  -- Purchase & GRN
  if 'purchase.unposted_orders' = any (v_cats) then
    insert into pg_temp.dept_plan select 'purchase.unposted_orders', 'purchase_orders', id::text, 'purchase_orders', id::text
    from public.purchase_orders where company_id = p_company and status in ('DRAFT', 'CANCELLED');
    insert into pg_temp.dept_plan select 'purchase.unposted_orders', 'purchase_orders', x.po::text, x.t, x.id::text
    from (select purchase_order_id po, 'purchase_order_lines' t, id from public.purchase_order_lines where company_id = p_company
          union all select purchase_order_id, 'purchase_order_events', id from public.purchase_order_events where company_id = p_company
          union all select purchase_order_id, 'purchase_order_amendments', id from public.purchase_order_amendments where company_id = p_company
          union all select purchase_order_id, 'purchase_order_import_refs', id from public.purchase_order_import_refs where company_id = p_company
          union all select purchase_order_id, 'purchase_document_refs', id from public.purchase_document_refs where company_id = p_company and purchase_order_id is not null) x
    join pg_temp.dept_plan p on p.table_name = 'purchase_orders' and p.row_key = x.po::text;
  end if;

  -- Production & Outsourcing
  if 'production.unposted_orders' = any (v_cats) then
    insert into pg_temp.dept_plan select 'production.unposted_orders', 'production_orders', id::text, 'production_orders', id::text
    from public.production_orders where company_id = p_company and status in ('DRAFT', 'CANCELLED');
    insert into pg_temp.dept_plan select 'production.unposted_orders', 'production_orders', x.o::text, x.t, x.k
    from (select production_order_id o, 'production_order_materials' t, id::text k from public.production_order_materials where company_id = p_company
          union all select production_order_id, 'production_order_events', id::text from public.production_order_events where company_id = p_company
          union all select production_order_id, 'production_order_requests', production_order_id::text from public.production_order_requests where company_id = p_company
          union all select production_order_id, 'production_order_revisions', id::text from public.production_order_revisions where company_id = p_company) x
    join pg_temp.dept_plan p on p.table_name = 'production_orders' and p.row_key = x.o::text;
  end if;
  if 'production.unposted_outsourcing' = any (v_cats) then
    insert into pg_temp.dept_plan select 'production.unposted_outsourcing', 'outsourcing_orders', id::text, 'outsourcing_orders', id::text
    from public.outsourcing_orders where company_id = p_company and status in ('DRAFT', 'CANCELLED');
    insert into pg_temp.dept_plan select 'production.unposted_outsourcing', 'outsourcing_orders', x.o::text, x.t, x.id::text
    from (select outsourcing_order_id o, 'outsourcing_order_materials' t, id from public.outsourcing_order_materials where company_id = p_company
          union all select outsourcing_order_id, 'outsourcing_order_events', id from public.outsourcing_order_events where company_id = p_company) x
    join pg_temp.dept_plan p on p.table_name = 'outsourcing_orders' and p.row_key = x.o::text;
  end if;

  -- Sales & Orders
  if 'sales.unposted_orders' = any (v_cats) then
    insert into pg_temp.dept_plan select 'sales.unposted_orders', 'sales_orders', id::text, 'sales_orders', id::text
    from public.sales_orders where company_id = p_company and order_status in ('DRAFT', 'CANCELLED');
    insert into pg_temp.dept_plan select 'sales.unposted_orders', 'sales_orders', x.o::text, x.t, x.id::text
    from (select sales_order_id o, 'sales_order_lines' t, id from public.sales_order_lines where company_id = p_company
          union all select sales_order_id, 'sales_order_events', id from public.sales_order_events where company_id = p_company) x
    join pg_temp.dept_plan p on p.table_name = 'sales_orders' and p.row_key = x.o::text;
  end if;
  if 'sales.customer_product_codes' = any (v_cats) then
    insert into pg_temp.dept_plan select 'sales.customer_product_codes', 'customer_product_codes', id::text, 'customer_product_codes', id::text
    from public.customer_product_codes where company_id = p_company;
  end if;
  if 'sales.legacy_customer_pos' = any (v_cats) then
    insert into pg_temp.dept_plan select 'sales.legacy_customer_pos', 'customer_purchase_orders', id::text, 'customer_purchase_orders', id::text
    from public.customer_purchase_orders where company_id = p_company;
    insert into pg_temp.dept_plan select 'sales.legacy_customer_pos', 'customer_purchase_orders', x.o::text, x.t, x.id::text
    from (select purchase_order_id o, 'customer_purchase_order_lines' t, id from public.customer_purchase_order_lines where company_id = p_company
          union all select purchase_order_id, 'customer_po_events', id from public.customer_po_events where company_id = p_company
          union all select purchase_order_id, 'customer_po_allocation_runs', id from public.customer_po_allocation_runs where company_id = p_company
          union all select purchase_order_id, 'customer_po_analysis_snapshots', id from public.customer_po_analysis_snapshots where company_id = p_company) x
    join pg_temp.dept_plan p on p.table_name = 'customer_purchase_orders' and p.row_key = x.o::text;
    insert into pg_temp.dept_plan select 'sales.legacy_customer_pos', p.root_table, p.root_key, 'customer_po_shortage_notes', n.id::text
    from public.customer_po_shortage_notes n join pg_temp.dept_plan p on p.table_name = 'customer_purchase_order_lines' and p.row_key = n.line_id::text
    where n.company_id = p_company;
    -- Import batches all of whose purchase orders go (a batch still used by another PO is blocked by the reference check).
    insert into pg_temp.dept_plan select distinct 'sales.legacy_customer_pos', 'customer_po_import_batches', b.id::text, 'customer_po_import_batches', b.id::text
    from public.customer_po_import_batches b
    where b.company_id = p_company
      and exists (select 1 from public.customer_purchase_orders o join pg_temp.dept_plan p on p.table_name = 'customer_purchase_orders' and p.row_key = o.id::text
                  where o.import_batch_id = b.id);
  end if;

  -- Billing & Invoice
  if 'billing.draft_invoices' = any (v_cats) then
    insert into pg_temp.dept_plan select 'billing.draft_invoices', 'sales_invoices', id::text, 'sales_invoices', id::text
    from public.sales_invoices where company_id = p_company and status in ('DRAFT', 'DISCARDED') and invoice_number is null and proforma_number is null;
    insert into pg_temp.dept_plan select 'billing.draft_invoices', 'sales_invoices', x.o::text, x.t, x.id::text
    from (select invoice_id o, 'sales_invoice_lines' t, id from public.sales_invoice_lines where company_id = p_company
          union all select invoice_id, 'sales_invoice_dispatch_allocations', id from public.sales_invoice_dispatch_allocations where company_id = p_company
          union all select coalesce(invoice_id, entity_id), 'billing_events', id from public.billing_events
                    where company_id = p_company and (entity_type = 'INVOICE' or invoice_id is not null)) x
    join pg_temp.dept_plan p on p.table_name = 'sales_invoices' and p.row_key = x.o::text
    on conflict do nothing;
  end if;
  if 'billing.draft_notes' = any (v_cats) then
    insert into pg_temp.dept_plan select 'billing.draft_notes', 'invoice_adjustment_notes', id::text, 'invoice_adjustment_notes', id::text
    from public.invoice_adjustment_notes where company_id = p_company and status in ('DRAFT', 'DISCARDED') and note_number is null;
    insert into pg_temp.dept_plan select 'billing.draft_notes', 'invoice_adjustment_notes', x.o::text, x.t, x.id::text
    from (select note_id o, 'invoice_adjustment_note_lines' t, id from public.invoice_adjustment_note_lines where company_id = p_company
          union all select entity_id, 'billing_events', id from public.billing_events where company_id = p_company and entity_type = 'NOTE') x
    join pg_temp.dept_plan p on p.table_name = 'invoice_adjustment_notes' and p.row_key = x.o::text
    on conflict do nothing;
  end if;

  -- Ledger
  if 'ledger.archive_dormant' = any (v_cats) then
    insert into pg_temp.dept_plan select 'ledger.archive_dormant', 'customers', c.id::text, 'customers', c.id::text
    from public.customers c
    where c.company_id = p_company and c.status = 'ACTIVE'
      and not exists (select 1 from public.sales_orders o where o.customer_id = c.id and o.order_status not in ('FULFILLED', 'CANCELLED'))
      and not exists (select 1 from public.sales_invoices i where i.customer_id = c.id and i.status in ('DRAFT', 'PENDING_APPROVAL'))
      and not exists (select 1 from private.party_balances(p_company) b where b.customer_id = c.id and (b.receivable <> 0 or b.invoice_outstanding <> 0));
    insert into pg_temp.dept_plan select 'ledger.archive_dormant', 'suppliers', s.id::text, 'suppliers', s.id::text
    from public.suppliers s
    where s.company_id = p_company and s.status = 'ACTIVE'
      and not exists (select 1 from public.purchase_orders o where o.supplier_id = s.id and o.status in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED'))
      and not exists (select 1 from private.party_balances(p_company) b where b.supplier_id = s.id and b.payable <> 0);
  end if;
  if 'ledger.unused_parties' = any (v_cats) then
    -- Parties whose customer and supplier sides are inactive, with no opening balance.
    insert into pg_temp.dept_plan select 'ledger.unused_parties', 'parties', p.id::text, 'parties', p.id::text
    from public.parties p
    left join public.customers c on c.id = p.customer_id left join public.suppliers s on s.id = p.supplier_id
    where p.company_id = p_company and coalesce(p.opening_balance, 0) = 0
      and (p.customer_id is null or c.status = 'INACTIVE') and (p.supplier_id is null or s.status = 'INACTIVE');
    insert into pg_temp.dept_plan select 'ledger.unused_parties', 'parties', p.id::text, x.t, x.id::text
    from public.parties p join pg_temp.dept_plan q on q.table_name = 'parties' and q.row_key = p.id::text
    cross join lateral (values ('customers', p.customer_id), ('suppliers', p.supplier_id)) x (t, id)
    where x.id is not null on conflict do nothing;
    -- Inactive customers / suppliers without a ledger party.
    insert into pg_temp.dept_plan select 'ledger.unused_parties', 'customers', c.id::text, 'customers', c.id::text
    from public.customers c where c.company_id = p_company and c.status = 'INACTIVE'
      and not exists (select 1 from public.parties p where p.customer_id = c.id) on conflict do nothing;
    insert into pg_temp.dept_plan select 'ledger.unused_parties', 'suppliers', s.id::text, 'suppliers', s.id::text
    from public.suppliers s where s.company_id = p_company and s.status = 'INACTIVE'
      and not exists (select 1 from public.parties p where p.supplier_id = s.id) on conflict do nothing;
  end if;

  -- ---- Rows of removed documents in cross-cutting tables, and closed reservations -------------
  if p_operation = 'DELETE' then
    insert into pg_temp.dept_plan select p.category, p.root_table, p.root_key, 'stock_reservations', r.id::text
    from public.stock_reservations r join pg_temp.dept_plan p on p.row_key = r.reference_id::text
    where r.company_id = p_company and r.reservation_status in ('RELEASED', 'CANCELLED', 'EXPIRED')
      and p.table_name in ('sales_orders', 'sales_order_lines', 'production_orders', 'customer_purchase_orders', 'customer_purchase_order_lines')
    on conflict do nothing;
    insert into pg_temp.dept_plan select p.category, p.root_table, p.root_key, 'notifications', n.id::text
    from public.notifications n join pg_temp.dept_plan p on p.table_name = p.root_table and p.row_key = n.related_entity_id::text
    where n.company_id = p_company on conflict do nothing;
    insert into pg_temp.dept_plan select p.category, p.root_table, p.root_key, 'erp_form_drafts', d.id::text
    from public.erp_form_drafts d join pg_temp.dept_plan p on p.table_name = p.root_table and p.row_key = d.record_id::text
    where d.company_id = p_company on conflict do nothing;
  end if;

  -- ---- Blocking (DELETE and RESET); repeated until no root changes -------------------------
  if p_operation in ('DELETE', 'RESET') then
    loop
      v_round := v_round + 1;
      v_changed := false;
      -- Any foreign key from a row outside the plan to a planned row.
      for fk in
        select con.conrelid::regclass::text as child_q, cl.relname as child, pl.relname as parent, con.conkey, con.confkey
        from pg_constraint con join pg_class cl on cl.oid = con.conrelid join pg_namespace cn on cn.oid = cl.relnamespace
        join pg_class pl on pl.oid = con.confrelid join pg_namespace pn on pn.oid = pl.relnamespace
        where con.contype = 'f' and cn.nspname = 'public' and pn.nspname = 'public'
          and pl.relname in (select distinct table_name from pg_temp.dept_plan)
      loop
        v_join := '';
        for i in 1 .. array_length(fk.conkey, 1) loop
          v_join := v_join || case when i > 1 then ' and ' else '' end || format('c.%I = par.%I',
            (select attname from pg_attribute where attrelid = ('public.' || quote_ident(fk.child))::regclass and attnum = fk.conkey[i]),
            (select attname from pg_attribute where attrelid = ('public.' || quote_ident(fk.parent))::regclass and attnum = fk.confkey[i]));
        end loop;
        v_ckey := case when exists (select 1 from pg_attribute where attrelid = ('public.' || quote_ident(fk.child))::regclass
                                    and attname = private.dept_key_col(fk.child) and not attisdropped)
                       then format('c.%I::text', private.dept_key_col(fk.child)) else 'c.ctid::text' end;
        execute format(
          'insert into pg_temp.dept_blocked (category, root_table, root_key, reason, ref_table, ref_key)
           select distinct p.category, p.root_table, p.root_key, %L, %L, %s
           from pg_temp.dept_plan p join public.%I par on par.%I::text = p.row_key join public.%I c on %s
           where p.table_name = %L and par.company_id = $1
             and not exists (select 1 from pg_temp.dept_plan q where q.table_name = %L and q.row_key = %s)
             and not exists (select 1 from pg_temp.dept_blocked b where b.root_table = p.root_table and b.root_key = p.root_key)',
          'Used by ' || replace(fk.child, '_', ' '), fk.child, v_ckey, fk.parent, private.dept_key_col(fk.parent), fk.child, v_join,
          fk.parent, fk.child, v_ckey) using p_company;
        get diagnostics v_hits = row_count;  -- EXECUTE does not set FOUND
        if v_hits > 0 then v_changed := true; end if;
      end loop;

      -- Links without a foreign key.
      insert into pg_temp.dept_blocked (category, root_table, root_key, reason, ref_table, ref_key)
      select distinct p.category, p.root_table, p.root_key, 'Stock was moved for it (posted stock movement)', 'inventory_transactions', t.id::text
      from pg_temp.dept_plan p join public.inventory_transactions t on t.company_id = p_company
        and (t.reference_id::text = p.row_key or t.document_id::text = p.row_key)
      where not exists (select 1 from pg_temp.dept_blocked b where b.root_table = p.root_table and b.root_key = p.root_key);
      if found then v_changed := true; end if;

      insert into pg_temp.dept_blocked (category, root_table, root_key, reason, ref_table, ref_key)
      select distinct p.category, p.root_table, p.root_key, 'Has an open stock reservation', 'stock_reservations', r.id::text
      from pg_temp.dept_plan p join public.stock_reservations r on r.company_id = p_company and r.reference_id::text = p.row_key
      where r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED', 'FULFILLED')
        and not exists (select 1 from pg_temp.dept_plan q where q.table_name = 'stock_reservations' and q.row_key = r.id::text)
        and not exists (select 1 from pg_temp.dept_blocked b where b.root_table = p.root_table and b.root_key = p.root_key);
      if found then v_changed := true; end if;

      insert into pg_temp.dept_blocked (category, root_table, root_key, reason, ref_table, ref_key)
      select distinct p.category, p.root_table, p.root_key, 'Waiting for approval', 'approval_requests', a.id::text
      from pg_temp.dept_plan p join public.approval_requests a on a.company_id = p_company and a.document_id::text = p.row_key
      where a.status = 'PENDING_APPROVAL'
        and not exists (select 1 from pg_temp.dept_blocked b where b.root_table = p.root_table and b.root_key = p.root_key);
      if found then v_changed := true; end if;

      insert into pg_temp.dept_blocked (category, root_table, root_key, reason, ref_table, ref_key)
      select distinct p.category, p.root_table, p.root_key, 'A production order was made for it', 'production_orders', o.id::text
      from pg_temp.dept_plan p join public.production_orders o on o.company_id = p_company
        and (o.sales_order_id::text = p.row_key or o.sales_order_line_id::text = p.row_key)
      where p.table_name in ('sales_orders', 'sales_order_lines')
        and not exists (select 1 from pg_temp.dept_plan q where q.table_name = 'production_orders' and q.row_key = o.id::text)
        and not exists (select 1 from pg_temp.dept_blocked b where b.root_table = p.root_table and b.root_key = p.root_key);
      if found then v_changed := true; end if;

      insert into pg_temp.dept_blocked (category, root_table, root_key, reason, ref_table, ref_key)
      select distinct p.category, p.root_table, p.root_key, 'An invoice was made for it', 'sales_invoices', i.id::text
      from pg_temp.dept_plan p join public.sales_invoices i on i.company_id = p_company and i.sales_order_id::text = p.row_key
      where p.table_name = 'sales_orders'
        and not exists (select 1 from pg_temp.dept_plan q where q.table_name = 'sales_invoices' and q.row_key = i.id::text)
        and not exists (select 1 from pg_temp.dept_blocked b where b.root_table = p.root_table and b.root_key = p.root_key);
      if found then v_changed := true; end if;

      -- Remove every row of a blocked root; other roots may now be referenced from outside the plan.
      delete from pg_temp.dept_plan p using pg_temp.dept_blocked b where b.root_table = p.root_table and b.root_key = p.root_key;
      exit when not v_changed or v_round >= 20;
    end loop;
    if v_round >= 20 and v_changed then
      raise exception 'The deletion plan did not settle; nothing can be changed.' using errcode = 'P0001';
    end if;
  end if;

  select coalesce(jsonb_object_agg(table_name, n), '{}'::jsonb) into v_tables
  from (select table_name, count(*) n from pg_temp.dept_plan group by 1) x;
  select md5(p_department || '|' || p_operation || '|' || array_to_string(v_cats, ',') || '|' ||
             coalesce(string_agg(table_name || ':' || row_key, ',' order by table_name, row_key), ''))
    into v_hash from pg_temp.dept_plan;

  select jsonb_build_object(
    'department', p_department, 'operation', p_operation, 'categories', to_jsonb(v_cats), 'plan_hash', v_hash,
    'tables', v_tables, 'total', (select count(*) from pg_temp.dept_plan),
    'by_category', coalesce((select jsonb_agg(jsonb_build_object('code', c.code, 'label', c.label, 'description', c.description,
        'records', (select count(distinct root_key) from pg_temp.dept_plan p where p.category = c.code),
        'rows', (select count(*) from pg_temp.dept_plan p where p.category = c.code),
        'blocked', (select count(distinct b.root_key) from pg_temp.dept_blocked b where b.category = c.code)) order by c.sort)
      from private.dept_categories() c where c.code = any (v_cats)), '[]'::jsonb),
    'blocked', coalesce((select jsonb_agg(x order by x ->> 'category', x ->> 'record') from (
        select jsonb_build_object('category', b.category, 'table', b.root_table, 'key', b.root_key,
          'record', private.dept_row_label(b.root_table, b.root_key),
          'reasons', jsonb_agg(distinct b.reason),
          'references', (select jsonb_agg(jsonb_build_object('table', r.ref_table, 'department', private.dept_of_table(r.ref_table),
                            'record', private.dept_row_label(r.ref_table, r.ref_key)))
                         from (select distinct b2.ref_table, b2.ref_key from pg_temp.dept_blocked b2
                               where b2.root_table = b.root_table and b2.root_key = b.root_key and b2.ref_key is not null
                                 and b2.ref_table is not null order by 1, 2 limit 5) r)) x
        from pg_temp.dept_blocked b group by b.category, b.root_table, b.root_key
        order by b.category, b.root_key limit 200) y), '[]'::jsonb),
    'blocked_total', (select count(distinct (root_table, root_key)) from pg_temp.dept_blocked),
    'affected_departments', coalesce((select jsonb_agg(distinct d) from (
        select private.dept_of_table(table_name) d from pg_temp.dept_plan
        union select private.dept_of_table(ref_table) from pg_temp.dept_blocked where ref_table is not null) z where d <> 'OTHER'), '[]'::jsonb))
  into v_result;
  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Checks shared by the public functions
-- -----------------------------------------------------------------------------
-- Super Admin of the caller's own company (the company is never taken from the request).
create or replace function private.dept_caller_company()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := auth.uid();
  v_company uuid;
begin
  if v_actor is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;
  select company_id into v_company from public.profiles where id = v_actor;
  if v_company is null or not private.erp_reset_actor_ok(v_actor, v_company) then
    raise exception 'Only an active Super Admin with the system.reset_data permission can manage department data.' using errcode = '42501';
  end if;
  return v_company;
end;
$$;

-- A password sign-in in the last few minutes (Supabase puts it in the session token's amr claim).
create or replace function private.dept_recent_password(p_minutes int default 5)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from jsonb_array_elements(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'amr', '[]'::jsonb)) a
    where a ->> 'method' = 'password'
      and to_timestamp((a ->> 'timestamp')::double precision) > now() - make_interval(mins => p_minutes)
      and to_timestamp((a ->> 'timestamp')::double precision) <= now() + interval '1 minute');
$$;

create or replace function private.dept_valid_request(p_department text, p_operation text, p_categories text[])
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_department is null or p_department not in ('PRODUCTS', 'INVENTORY', 'PURCHASE', 'PRODUCTION', 'SALES', 'BILLING', 'LEDGER') then
    raise exception 'Unknown department.' using errcode = '22023';
  end if;
  if p_operation is null or p_operation not in ('ARCHIVE', 'RESET', 'DELETE') then
    raise exception 'Unknown operation.' using errcode = '22023';
  end if;
  if p_categories is null or cardinality(p_categories) = 0 then
    raise exception 'Choose at least one category.' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_categories) x
             where not exists (select 1 from private.dept_categories() c where c.code = x and c.department = p_department and c.operation = p_operation)) then
    raise exception 'A chosen category does not belong to this department and operation.' using errcode = '22023';
  end if;
end;
$$;

-- Rows of every company table, for this company and for all others (verification).
create or replace function private.dept_row_counts(p_company uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r     record;
  v_own bigint;
  v_all bigint;
  v_out jsonb := '{}'::jsonb;
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r'
             and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped)
           order by 1 loop
    execute format('select count(*) filter (where company_id = $1), count(*) from public.%I', r.relname) into v_own, v_all using p_company;
    v_out := v_out || jsonb_build_object(r.relname, jsonb_build_array(v_own, v_all - v_own));
  end loop;
  return v_out;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Public functions (RPC)
-- -----------------------------------------------------------------------------
-- Every department with its categories and how many records each would change now.
create or replace function public.department_data_overview()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_out     jsonb := '[]'::jsonb;
  v_plan    jsonb;
  d         record;
  o         record;
  v_cats    jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;
  v_company := private.dept_caller_company();
  for d in select distinct department from private.dept_categories() loop
    v_cats := '[]'::jsonb;
    for o in select distinct operation from private.dept_categories() c where c.department = d.department loop
      v_plan := private.dept_plan(v_company, d.department, o.operation, null);
      v_cats := v_cats || (select coalesce(jsonb_agg(x || jsonb_build_object('operation', o.operation)), '[]'::jsonb) from jsonb_array_elements(v_plan -> 'by_category') x);
    end loop;
    v_out := v_out || jsonb_build_array(jsonb_build_object('department', d.department, 'categories', v_cats));
  end loop;
  return jsonb_build_object('departments', v_out, 'generated_at', now(),
    'backup', private.erp_force_reset_valid_backup(v_company, null),
    'last_runs', coalesce((select jsonb_agg(to_jsonb(r) order by r.started_at desc) from (
        select id, department, operation, categories, status, started_at, finished_at, deleted_total, error_message
        from public.erp_reset_runs where company_id = v_company and mode = 'DEPARTMENT' order by started_at desc limit 10) r), '[]'::jsonb));
end;
$$;

-- What an operation would change (nothing is changed).
create or replace function public.department_data_preview(p_department text, p_operation text, p_categories text[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.dept_caller_company();
  v_plan    jsonb;
begin
  perform private.dept_valid_request(p_department, p_operation, p_categories);
  v_plan := private.dept_plan(v_company, p_department, p_operation, p_categories);
  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, metadata)
  values (v_company, auth.uid(), 'department_data.previewed', 'department_data',
          jsonb_build_object('department', p_department, 'operation', p_operation, 'categories', p_categories,
                             'total', v_plan -> 'total', 'blocked', v_plan -> 'blocked_total', 'plan_hash', v_plan ->> 'plan_hash'));
  return v_plan || jsonb_build_object(
    'confirmation_phrase', p_operation || ' ' || p_department,
    'requires_backup', p_operation = 'DELETE', 'requires_password', p_operation = 'DELETE',
    'backup', case when p_operation = 'DELETE' then private.erp_force_reset_valid_backup(v_company, null) end);
end;
$$;

-- Runs the operation in one transaction.
create or replace function public.department_data_execute(p_department text, p_operation text, p_categories text[], p_plan_hash text,
  p_confirmation text, p_backup_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := auth.uid();
  v_company  uuid;
  v_run      public.erp_reset_runs;
  v_plan     jsonb;
  v_status   text;
  v_error    text;
  v_counts   jsonb := '{}'::jsonb;
  v_total    bigint := 0;
  v_before   jsonb;
  v_after    jsonb;
  v_problems text[] := '{}';
  v_session  uuid;
  v_current  text;
  v_n        bigint;
  v_backup   jsonb;
  v_verify   jsonb := '{}'::jsonb;
  r          record;
  v_keys     text[];
  v_deny     text;
begin
  v_company := private.dept_caller_company();
  perform private.dept_valid_request(p_department, p_operation, p_categories);
  if p_request_id is null or p_plan_hash is null then
    raise exception 'Preview first; the request id and the preview are required.' using errcode = '22023';
  end if;

  -- Idempotency: the same request returns its stored result.
  select * into v_run from public.erp_reset_runs where company_id = v_company and request_id = p_request_id;
  if found then
    return to_jsonb(v_run) || jsonb_build_object('replayed', true);
  end if;
  -- One reset or data operation per company at a time (same lock as the ERP resets).
  if not pg_try_advisory_xact_lock(hashtextextended('erp_reset:' || v_company::text, 0)) then
    return jsonb_build_object('status', 'IN_PROGRESS', 'error', 'Another reset or data operation of this company is running. Wait for it to finish.');
  end if;

  -- Confirmation, and for permanent delete: backup record and recent password sign-in.
  if p_confirmation is distinct from p_operation || ' ' || p_department then
    v_deny := format('Type %s %s to confirm.', p_operation, p_department);
  elsif p_operation = 'DELETE' then
    v_backup := private.erp_force_reset_valid_backup(v_company, p_backup_id);
    if p_backup_id is null or v_backup is null then
      v_deny := 'Record a backup taken in the last 24 hours first (each backup record can be used once).';
    elsif (v_backup ->> 'recorded_by')::uuid is distinct from v_actor then
      v_deny := 'Use a backup record you made yourself.';
    elsif not private.dept_recent_password(5) then
      v_deny := 'Enter your password again (it must be confirmed in the last 5 minutes).';
    end if;
  end if;
  if v_deny is not null then
    insert into public.audit_logs (company_id, actor_user_id, action, resource_type, metadata)
    values (v_company, v_actor, 'department_data.denied', 'department_data',
            jsonb_build_object('department', p_department, 'operation', p_operation, 'categories', p_categories, 'reason', v_deny, 'request_id', p_request_id));
    return jsonb_build_object('status', 'DENIED', 'error', v_deny);
  end if;

  v_plan := private.dept_plan(v_company, p_department, p_operation, p_categories);
  if (v_plan ->> 'plan_hash') is distinct from p_plan_hash then
    v_status := 'BLOCKED';
    v_error := 'The data changed after the preview. Nothing was changed; preview again.';
  elsif (v_plan ->> 'total')::bigint = 0 then
    v_status := 'BLOCKED';
    v_error := 'Nothing is eligible. Nothing was changed.';
  else
    begin
      v_before := private.dept_row_counts(v_company);
      if p_operation in ('DELETE', 'RESET') then
        insert into private.dept_purge_sessions (company_id, actor, request_id, txid)
        values (v_company, v_actor, p_request_id, txid_current()) returning id into v_session;
        insert into private.dept_purge_rows (session_id, table_name, row_key)
        select v_session, table_name, row_key from pg_temp.dept_plan;
        perform set_config('app.dept_purge', v_session::text, true);

        for r in select table_name, private.dept_table_ord(table_name) ord from pg_temp.dept_plan group by 1 order by 2, 1 loop
          if r.ord is null then
            raise exception 'No deletion order for %', r.table_name;
          end if;
          v_current := r.table_name;
          select array_agg(row_key) into v_keys from pg_temp.dept_plan where table_name = r.table_name;
          execute format('delete from public.%I t where t.company_id = $1 and t.%I::text = any ($2)', r.table_name, private.dept_key_col(r.table_name))
            using v_company, v_keys;
          get diagnostics v_n = row_count;
          if v_n <> cardinality(v_keys) then
            raise exception 'expected % rows, deleted %', cardinality(v_keys), v_n;
          end if;
          v_counts := v_counts || jsonb_build_object(r.table_name, v_n);
          v_total := v_total + v_n;
        end loop;
        v_current := null;
        perform set_config('app.dept_purge', '', true);
        delete from private.dept_purge_sessions where id = v_session;
      else
        -- ARCHIVE: the existing inactive / archived states, through the normal rules and triggers.
        for r in select category, table_name, array_agg(row_key) keys from pg_temp.dept_plan group by 1, 2 order by 1, 2 loop
          v_current := r.table_name;
          if r.category = 'products.archive_inactive' then
            update public.products set archived_at = now(), change_reason = 'Archived by Department Data Management'
            where company_id = v_company and id::text = any (r.keys) and status = 'INACTIVE' and archived_at is null;
          elsif r.category = 'inventory.archive_empty_warehouses' then
            update public.warehouses set status = 'INACTIVE' where company_id = v_company and id::text = any (r.keys) and status = 'ACTIVE';
          elsif r.category = 'ledger.archive_dormant' and r.table_name = 'customers' then
            update public.customers set status = 'INACTIVE' where company_id = v_company and id::text = any (r.keys) and status = 'ACTIVE';
          elsif r.category = 'ledger.archive_dormant' and r.table_name = 'suppliers' then
            update public.suppliers set status = 'INACTIVE' where company_id = v_company and id::text = any (r.keys) and status = 'ACTIVE';
          else
            raise exception 'No archive rule for % / %', r.category, r.table_name;
          end if;
          get diagnostics v_n = row_count;
          if v_n <> cardinality(r.keys) then
            raise exception 'expected % rows, changed %', cardinality(r.keys), v_n;
          end if;
          v_counts := v_counts || jsonb_build_object(r.table_name, coalesce((v_counts ->> r.table_name)::bigint, 0) + v_n);
          v_total := v_total + v_n;
        end loop;
        v_current := null;
      end if;

      -- Verification inside the transaction; any difference rolls everything back.
      v_after := private.dept_row_counts(v_company);
      for r in select key, value from jsonb_each(v_before) loop
        if (v_after -> r.key ->> 1) is distinct from (r.value ->> 1) then
          v_problems := v_problems || format('rows of other companies changed in %s', r.key);
        end if;
        if r.key = 'audit_logs' then
          continue;
        end if;
        if p_operation in ('DELETE', 'RESET') then
          if (v_after -> r.key ->> 0)::bigint <> (r.value ->> 0)::bigint - coalesce((v_counts ->> r.key)::bigint, 0) then
            v_problems := v_problems || format('%s: expected %s rows, found %s', r.key,
              (r.value ->> 0)::bigint - coalesce((v_counts ->> r.key)::bigint, 0), v_after -> r.key ->> 0);
          end if;
        elsif (v_after -> r.key ->> 0) is distinct from (r.value ->> 0) and r.key not in ('product_versions') then
          v_problems := v_problems || format('%s: rows added or removed by an archive', r.key);
        end if;
      end loop;
      if not private.erp_reset_actor_ok(v_actor, v_company) then
        v_problems := v_problems || 'the Super Admin lost access'::text;
      end if;
      if cardinality(v_problems) > 0 then
        raise exception 'DEPARTMENT_DATA_VERIFICATION_FAILED: %', array_to_string(v_problems, '; ');
      end if;
      v_verify := jsonb_build_object('other_companies_unchanged', true, 'only_planned_rows_changed', true, 'actor_access_valid', true);
      v_status := 'COMPLETED';
    exception when others then
      -- Every change of this attempt is rolled back with the block.
      perform set_config('app.dept_purge', '', true);
      v_status := 'FAILED';
      v_error := left(case when v_current is not null then format('Changing %s failed: %s', v_current, sqlerrm) else sqlerrm end, 2000);
      v_counts := '{}'::jsonb;
      v_total := 0;
      v_verify := jsonb_build_object('rolled_back', true);
    end;
  end if;

  insert into public.erp_reset_runs (company_id, request_id, requested_by, status, mode, department, operation, categories, plan_hash,
                                     deleted_counts, deleted_total, blockers, verification, error_message, backup_id)
  values (v_company, p_request_id, v_actor, v_status, 'DEPARTMENT', p_department, p_operation, p_categories, v_plan ->> 'plan_hash',
          v_counts, v_total, coalesce(v_plan -> 'blocked', '[]'::jsonb), v_verify, v_error,
          case when p_operation = 'DELETE' and v_status = 'COMPLETED' then p_backup_id end)
  returning * into v_run;

  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, request_id, metadata)
  values (v_company, v_actor, 'department_data.' || lower(v_status), 'department_data', v_run.id::text, p_request_id::text,
          jsonb_build_object('department', p_department, 'operation', p_operation, 'categories', p_categories, 'status', v_status,
                             'affected_total', v_total, 'affected', v_counts, 'blocked', v_plan -> 'blocked_total',
                             'backup_id', case when p_operation = 'DELETE' then p_backup_id end, 'error', left(v_error, 500)));

  return to_jsonb(v_run) || jsonb_build_object('replayed', false);
end;
$$;

-- Department runs of the caller's company, newest first.
create or replace function public.department_data_history(p_limit int default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;
  v_company := private.dept_caller_company();
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.started_at desc) from (
    select r.id, r.department, r.operation, r.categories, r.status, r.started_at, r.finished_at, r.deleted_counts, r.deleted_total,
           r.blockers, r.error_message, r.request_id, r.backup_id, coalesce(p.full_name, p.email) as requested_by
    from public.erp_reset_runs r left join public.profiles p on p.id = r.requested_by
    where r.company_id = v_company and r.mode = 'DEPARTMENT'
    order by r.started_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) x), '[]'::jsonb);
end;
$$;

revoke all on function private.dept_categories(), private.dept_table_ord(text), private.dept_key_col(text), private.dept_of_table(text),
  private.dept_row_label(text, text), private.dept_plan(uuid, text, text, text[]), private.dept_caller_company(),
  private.dept_recent_password(int), private.dept_valid_request(text, text, text[]), private.dept_row_counts(uuid)
  from public, anon, authenticated;
revoke all on function public.department_data_overview(), public.department_data_preview(text, text, text[]),
  public.department_data_execute(text, text, text[], text, text, uuid, uuid), public.department_data_history(int) from public, anon;
grant execute on function public.department_data_overview(), public.department_data_preview(text, text, text[]),
  public.department_data_execute(text, text, text[], text, text, uuid, uuid), public.department_data_history(int) to authenticated;

-- -----------------------------------------------------------------------------
-- 7. Delete guards: one extra check each (rows registered for the running call only)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.prevent_history_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  -- Department data management (20261119090000): a row registered for deletion in the running
  -- department_data_execute call of this company and transaction may be deleted. Nothing else changes.
  if tg_op = 'DELETE' then
    if private.dept_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid, to_jsonb(old) ->> 'id') then return old; end if;
  end if;
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
  raise exception 'History records cannot be changed or deleted.' using errcode = '42501';
end;
$function$;

CREATE OR REPLACE FUNCTION private.guard_bom_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- Department data management (20261119090000): a row registered for deletion in the running
  -- department_data_execute call of this company and transaction may be deleted. Nothing else changes.
  if tg_op = 'DELETE' then
    if private.dept_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid, to_jsonb(old) ->> 'id') then return old; end if;
  end if;
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
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
$function$;

CREATE OR REPLACE FUNCTION private.guard_bom_item_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_status text;
begin
  -- Department data management (20261119090000): a row registered for deletion in the running
  -- department_data_execute call of this company and transaction may be deleted. Nothing else changes.
  if tg_op = 'DELETE' then
    if private.dept_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid, to_jsonb(old) ->> 'id') then return old; end if;
  end if;
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
  select status into v_status from public.boms where id = coalesce(new.bom_id, old.bom_id);
  if tg_op = 'UPDATE' and v_status in ('DRAFT', 'REJECTED', 'PENDING_APPROVAL')
     and (to_jsonb(new) - 'component_version_id') = (to_jsonb(old) - 'component_version_id') then
    return new;
  end if;
  if v_status not in ('DRAFT', 'REJECTED') then
    raise exception 'Components of a % BOM cannot be changed. Create a new version instead.', lower(v_status) using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$function$;

CREATE OR REPLACE FUNCTION private.guard_product_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- Department data management (20261119090000): a row registered for deletion in the running
  -- department_data_execute call of this company and transaction may be deleted. Nothing else changes.
  if tg_op = 'DELETE' then
    if private.dept_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid, to_jsonb(old) ->> 'id') then return old; end if;
  end if;
  if tg_op = 'DELETE' then
    if coalesce(current_setting('app.erp_force_purge', true), '') <> '' and private.erp_force_purge_allows(tg_table_name, old.company_id) then
      return old;
    end if;
    raise exception 'Product versions are permanent history and cannot be deleted.' using errcode = '42501';
  end if;
  if not old.is_current or new.is_current or new.effective_to is null
     or (to_jsonb(new) - array['effective_to', 'is_current']) <> (to_jsonb(old) - array['effective_to', 'is_current']) then
    raise exception 'Historical product versions are read-only. Change the product to create a new version.' using errcode = '42501';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private.guard_invoice_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- Department data management (20261119090000): a row registered for deletion in the running
  -- department_data_execute call of this company and transaction may be deleted. Nothing else changes.
  if tg_op = 'DELETE' then
    if private.dept_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid, to_jsonb(old) ->> 'id') then return old; end if;
  end if;
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
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
$function$;

CREATE OR REPLACE FUNCTION private.guard_invoice_line_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_status text;
begin
  -- Department data management (20261119090000): a row registered for deletion in the running
  -- department_data_execute call of this company and transaction may be deleted. Nothing else changes.
  if tg_op = 'DELETE' then
    if private.dept_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid, to_jsonb(old) ->> 'id') then return old; end if;
  end if;
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
  select status into v_status from public.sales_invoices where id = coalesce(new.invoice_id, old.invoice_id);
  -- Drafts are edited; invoices pending approval are only recalculated at issue.
  if v_status is null or v_status not in ('DRAFT', 'PENDING_APPROVAL') then
    raise exception 'Lines of a % invoice cannot be changed.', replace(lower(coalesce(v_status, 'unknown')), '_', ' ') using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$function$;

CREATE OR REPLACE FUNCTION private.guard_note_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_status text;
begin
  -- Department data management (20261119090000): a row registered for deletion in the running
  -- department_data_execute call of this company and transaction may be deleted. Nothing else changes.
  if tg_op = 'DELETE' then
    if private.dept_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid, to_jsonb(old) ->> 'id') then return old; end if;
  end if;
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
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
$function$;

CREATE OR REPLACE FUNCTION private.production_material_removed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- Department data management (20261119090000): the order itself is being deleted; no revision.
  if private.dept_purge_allows('production_orders', old.company_id, old.production_order_id::text) then
    return null;
  end if;
  if coalesce(current_setting('app.erp_force_purge', true), '') = ''
     and exists (select 1 from public.production_orders where id = old.production_order_id) then
    insert into public.production_order_revisions (company_id, production_order_id, kind, previous, reason, changed_by)
    values (old.company_id, old.production_order_id, 'MATERIAL_REMOVED', to_jsonb(old), private.production_revision_reason(), auth.uid());
  end if;
  return null;
end;
$function$;

