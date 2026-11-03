-- =============================================================================
-- ERP data reset ("factory reset" of one company's business data)
--
-- What it does
--   Deletes the business and operational records of the caller's company from
--   an explicit allowlist of tables (private.erp_reset_tables), children
--   first, in ONE transaction. Everything else is kept: the company, its
--   settings, users and profiles, roles and permissions, audit log, number
--   series, approval workflows, warehouses and locations, products and
--   categories, documents and the database schema itself.
--
-- What it never does
--   It never disables a trigger, constraint or RLS policy and never uses
--   TRUNCATE. The append-only guards (stock ledger, event histories, posted
--   documents, invoices, payments, BOMs, import history, approval decisions)
--   stay in force. If any of those tables holds rows for the company, the
--   reset STOPS before deleting anything and returns the list of blockers.
--   A deletion that still fails rolls back every deletion of the attempt and
--   is reported as FAILED.
--
-- Who can run it
--   public.erp_reset_preview()   read-only impact report; signed-in Super Admin
--                                with system.reset_data.
--   public.erp_reset_execute()   service_role ONLY, i.e. the reset-erp-data
--                                Edge Function after it has verified the
--                                user's session and password. Browsers cannot
--                                call it. Authorization is re-checked inside,
--                                under lock, from the database.
--
-- Safety
--   * per-company advisory lock: one reset at a time;
--   * idempotency key (request_id): a retried request returns the stored
--     result instead of running again;
--   * in-transaction verification (allowlist empty, kept tables unchanged,
--     schema objects unchanged, initiating Super Admin intact) or rollback;
--   * every attempt is appended to audit_logs and erp_reset_runs (both
--     append-only). No password or token ever reaches the database.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Permission (Super Admin only)
-- -----------------------------------------------------------------------------
insert into public.permissions (resource, action, description) values
  ('system', 'reset_data', 'Permanently delete the company''s business data (ERP reset). Super Admin only; requires password re-entry.')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code = 'system.reset_data'
where r.code = 'SUPER_ADMIN'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Reset history (append-only)
-- -----------------------------------------------------------------------------
create table if not exists public.erp_reset_runs (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete restrict,
  request_id       uuid not null,
  requested_by     uuid not null,
  status           text not null check (status in ('COMPLETED', 'BLOCKED', 'FAILED')),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz not null default clock_timestamp(),
  deleted_counts   jsonb not null default '{}'::jsonb,
  deleted_total    bigint not null default 0,
  preserved_counts jsonb not null default '{}'::jsonb,
  blockers         jsonb not null default '[]'::jsonb,
  verification     jsonb not null default '{}'::jsonb,
  error_message    text check (error_message is null or length(error_message) <= 2000),
  constraint erp_reset_runs_request_unique unique (company_id, request_id)
);

comment on table public.erp_reset_runs is
  'One row per executed ERP reset attempt (completed, blocked or failed). Append-only. Written only by public.erp_reset_execute.';

create index if not exists erp_reset_runs_company_time_idx on public.erp_reset_runs (company_id, started_at desc);

alter table public.erp_reset_runs enable row level security;
revoke all on public.erp_reset_runs from anon, authenticated;
grant select on public.erp_reset_runs to authenticated;

drop policy if exists erp_reset_runs_select on public.erp_reset_runs;
create policy erp_reset_runs_select on public.erp_reset_runs for select to authenticated
  using (private.has_permission(company_id, 'system.reset_data'));

drop trigger if exists erp_reset_runs_append_only on public.erp_reset_runs;
create trigger erp_reset_runs_append_only before update or delete on public.erp_reset_runs
  for each row execute function private.prevent_history_mutation();

-- -----------------------------------------------------------------------------
-- Classification of every public table
-- -----------------------------------------------------------------------------
-- Allowlist of resettable tables in deletion order (lower ord first: a table
-- is deleted only after every table that references it). The verification
-- suite checks this order against the real foreign keys and checks that every
-- public table is either here or in private.erp_reset_kept_tables().
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

-- Tables that are never touched. company_scoped = false: global catalogue
-- (counted whole); companies is counted by id.
create or replace function private.erp_reset_kept_tables()
returns table (table_name text, label text, company_scoped boolean)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('companies', 'Company record', true),
    ('company_settings', 'Company settings', true),
    ('profiles', 'User profiles', true),
    ('user_roles', 'Role assignments', true),
    ('roles', 'Roles', false),
    ('permissions', 'Permissions', false),
    ('role_permissions', 'Role permissions', false),
    ('audit_logs', 'Audit log', true),
    ('erp_reset_runs', 'Reset history', true),
    ('invoice_settings', 'Invoice settings', true),
    ('billing_number_sequences', 'Billing number series', true),
    ('inventory_number_sequences', 'Inventory number series', true),
    ('approval_workflows', 'Approval workflows', true),
    ('approval_workflow_stages', 'Approval workflow stages', true),
    ('notification_preferences', 'Notification preferences', true),
    ('notification_sync_state', 'Notification sync state', true),
    ('error_events', 'System error log', true),
    ('amazon_settings', 'Amazon settings', true),
    ('amazon_connections', 'Amazon connections', true),
    ('warehouses', 'Warehouses', true),
    ('inventory_locations', 'Warehouse locations', true),
    ('products', 'Products', true),
    ('product_categories', 'Product categories', true),
    ('documents', 'Documents', true),
    ('document_versions', 'Document files', true)
  ) t (table_name, label, company_scoped);
$$;

-- Document types attached to records the reset deletes. Documents are archived,
-- never deleted (their files live in Storage), so these block the reset.
create or replace function private.erp_reset_document_entity_types()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['BATCH', 'PRODUCTION_ORDER', 'OUTSOURCING_ORDER', 'CUSTOMER_PO', 'SALES_ORDER', 'DISPATCH', 'INVOICE', 'ADJUSTMENT_NOTE', 'CUSTOMER'];
$$;

-- Why a guarded table cannot be emptied (by guard function).
create or replace function private.erp_reset_guard_reason(p_function text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_function
    when 'prevent_ledger_mutation' then 'Posted stock movements are permanent; corrections are reversal entries.'
    when 'prevent_history_mutation' then 'Append-only history; it cannot be deleted.'
    when 'prevent_import_history_mutation' then 'Import history is append-only.'
    when 'prevent_approval_decision_mutation' then 'Approval decisions are append-only.'
    when 'guard_posted_document' then 'Posted documents can only be reversed, never deleted.'
    when 'guard_bom_write' then 'BOMs are never deleted; they are archived.'
    when 'guard_bom_item_write' then 'Components of submitted or approved BOMs cannot be removed.'
    when 'guard_invoice_change' then 'Invoices are never deleted; drafts are discarded and issued invoices cancelled.'
    when 'guard_invoice_line_change' then 'Lines of issued invoices cannot be removed.'
    when 'guard_payment_change' then 'Payments are never deleted; they are reversed.'
    when 'guard_note_change' then 'Credit and debit notes are never deleted.'
    else format('Protected by the database guard %s.', p_function)
  end;
$$;

-- Allowlisted tables protected by a BEFORE DELETE row trigger, read from the
-- live catalogue (so a guard added later is honoured automatically).
create or replace function private.erp_reset_guarded_tables()
returns table (table_name text, guard_function text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (c.relname) c.relname::text, p.proname::text
  from pg_trigger tg
  join pg_class c on c.oid = tg.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_proc p on p.oid = tg.tgfoid
  where n.nspname = 'public' and not tg.tgisinternal
    and (tg.tgtype & 1) <> 0   -- row
    and (tg.tgtype & 2) <> 0   -- before
    and (tg.tgtype & 8) <> 0   -- delete
    and c.relname in (select t.table_name from private.erp_reset_tables() t)
  order by c.relname, p.proname;
$$;

-- Object counts of the schemas the application owns. Must be identical before
-- and after a reset.
create or replace function private.erp_reset_schema_fingerprint()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'tables', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname in ('public', 'private') and c.relkind in ('r', 'v', 'm', 'p')),
    'rls_enabled', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity),
    'policies', (select count(*) from pg_policy pol join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public'),
    'triggers', (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and not t.tgisinternal),
    'enabled_triggers', (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
                         where n.nspname = 'public' and not t.tgisinternal and t.tgenabled <> 'D'),
    'constraints', (select count(*) from pg_constraint k join pg_namespace n on n.oid = k.connamespace where n.nspname = 'public'),
    'indexes', (select count(*) from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public'),
    'functions', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private'))
  );
$$;

-- Row counts of the company: {"deleted": {table: n}, "kept": {table: n}}.
create or replace function private.erp_reset_counts(p_company uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_deleted jsonb := '{}'::jsonb;
  v_kept    jsonb := '{}'::jsonb;
  v_n       bigint;
  r         record;
begin
  for r in select t.table_name from private.erp_reset_tables() t order by t.ord, t.table_name loop
    execute format('select count(*) from public.%I where company_id = $1', r.table_name) into v_n using p_company;
    v_deleted := v_deleted || jsonb_build_object(r.table_name, v_n);
  end loop;
  for r in select k.table_name, k.company_scoped from private.erp_reset_kept_tables() k loop
    if r.table_name = 'companies' then
      select count(*) into v_n from public.companies where id = p_company;
    elsif r.company_scoped then
      execute format('select count(*) from public.%I where company_id = $1', r.table_name) into v_n using p_company;
    else
      execute format('select count(*) from public.%I', r.table_name) into v_n;
    end if;
    v_kept := v_kept || jsonb_build_object(r.table_name, v_n);
  end loop;
  return jsonb_build_object('deleted', v_deleted, 'kept', v_kept);
end;
$$;

-- Whether a given user may reset the given company right now (active profile
-- and company, SUPER_ADMIN role, system.reset_data permission).
create or replace function private.erp_reset_actor_ok(p_user uuid, p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
      select 1 from public.profiles p join public.companies c on c.id = p.company_id
      where p.id = p_user and p.company_id = p_company and p.is_active and c.is_active)
    and private.user_has_role(p_user, p_company, 'SUPER_ADMIN')
    and exists (
      select 1 from public.user_roles ur
      join public.role_permissions rp on rp.role_id = ur.role_id
      join public.permissions perm on perm.id = rp.permission_id
      where ur.user_id = p_user and ur.company_id = p_company and perm.code = 'system.reset_data');
$$;

-- Suppliers still named as a product's preferred supplier are kept (products
-- are kept and reference them).
create or replace function private.erp_reset_kept_supplier_count(p_company uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) from public.suppliers s
  where s.company_id = p_company
    and exists (select 1 from public.products p where p.company_id = p_company and p.preferred_supplier_id = s.id);
$$;

-- Impact report: what would be deleted, what is kept, what blocks the reset.
create or replace function private.erp_reset_plan(p_company uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_counts   jsonb := private.erp_reset_counts(p_company);
  v_blockers jsonb := '[]'::jsonb;
  v_delete   jsonb := '[]'::jsonb;
  v_keep     jsonb := '[]'::jsonb;
  v_kept_sup bigint := private.erp_reset_kept_supplier_count(p_company);
  v_total    bigint := 0;
  v_n        bigint;
  r          record;
begin
  -- 1. Protected history in allowlisted tables.
  for r in
    select g.table_name, g.guard_function, t.label, t.category
    from private.erp_reset_guarded_tables() g join private.erp_reset_tables() t on t.table_name = g.table_name
    order by t.category, t.label
  loop
    v_n := (v_counts -> 'deleted' ->> r.table_name)::bigint;
    if v_n > 0 then
      v_blockers := v_blockers || jsonb_build_object('kind', 'PROTECTED_RECORDS', 'table', r.table_name, 'label', r.label,
        'category', r.category, 'rows', v_n, 'reason', private.erp_reset_guard_reason(r.guard_function));
    end if;
  end loop;

  -- 2. Documents attached to records that would be deleted.
  select count(*) into v_n from public.documents d
  where d.company_id = p_company and d.related_entity_type = any (private.erp_reset_document_entity_types());
  if v_n > 0 then
    v_blockers := v_blockers || jsonb_build_object('kind', 'ATTACHED_DOCUMENTS', 'table', 'documents', 'label', 'Documents',
      'category', 'Documents', 'rows', v_n,
      'reason', 'Documents attached to orders, invoices, customers, dispatches or batches are archived, never deleted, and their files are in Storage.');
  end if;

  -- 3. Tables nobody has classified yet (added by a later migration).
  for r in
    select c.relname::text as table_name from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and c.relname not in (select t.table_name from private.erp_reset_tables() t)
      and c.relname not in (select k.table_name from private.erp_reset_kept_tables() k)
    order by 1
  loop
    v_blockers := v_blockers || jsonb_build_object('kind', 'UNCLASSIFIED_TABLE', 'table', r.table_name, 'label', r.table_name,
      'category', 'Schema', 'rows', null,
      'reason', 'This table is not classified as resettable or kept. Review it before resetting.');
  end loop;

  for r in select t.ord, t.table_name, t.category, t.label from private.erp_reset_tables() t order by t.category, t.label loop
    v_n := (v_counts -> 'deleted' ->> r.table_name)::bigint - case when r.table_name = 'suppliers' then v_kept_sup else 0 end;
    v_total := v_total + v_n;
    v_delete := v_delete || jsonb_build_object('table', r.table_name, 'category', r.category, 'label', r.label, 'rows', v_n);
  end loop;
  for r in select k.table_name, k.label from private.erp_reset_kept_tables() k loop
    v_keep := v_keep || jsonb_build_object('table', r.table_name, 'label', r.label, 'rows', (v_counts -> 'kept' ->> r.table_name)::bigint);
  end loop;
  v_keep := v_keep || jsonb_build_object('table', 'suppliers', 'label', 'Suppliers named as a product''s preferred supplier', 'rows', v_kept_sup);

  return jsonb_build_object(
    'company_id', p_company,
    'can_reset', jsonb_array_length(v_blockers) = 0,
    'blockers', v_blockers,
    'delete', v_delete,
    'delete_total', v_total,
    'keep', v_keep,
    'kept_suppliers', v_kept_sup,
    'counts', v_counts);
end;
$$;

-- -----------------------------------------------------------------------------
-- Public API
-- -----------------------------------------------------------------------------
create or replace function public.erp_reset_preview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_plan    jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if v_company is null or not private.has_role(v_company, 'SUPER_ADMIN') or not private.has_permission(v_company, 'system.reset_data') then
    raise exception 'Only a Super Admin with the system.reset_data permission can reset ERP data.' using errcode = '42501';
  end if;
  v_plan := private.erp_reset_plan(v_company) - 'counts';
  return v_plan || jsonb_build_object(
    'generated_at', now(),
    'recent_runs', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'started_at', r.started_at, 'requested_by', r.requested_by,
               'deleted_total', r.deleted_total, 'error_message', r.error_message) order by r.started_at desc)
      from (select * from public.erp_reset_runs where company_id = v_company order by started_at desc limit 5) r), '[]'::jsonb));
end;
$$;

revoke all on function public.erp_reset_preview() from public, anon;
grant execute on function public.erp_reset_preview() to authenticated;

-- Password re-entry attempts (rate limit). Service role only.
create or replace function public.erp_reset_record_attempt(p_actor uuid, p_outcome text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_failures int;
begin
  if p_outcome not in ('REAUTH_FAILED', 'REAUTH_UNSUPPORTED', 'DENIED') then
    raise exception 'Unknown outcome' using errcode = '22023';
  end if;
  select company_id into v_company from public.profiles where id = p_actor;
  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_company, p_actor, 'erp_reset.' || lower(p_outcome), 'erp_reset', null, jsonb_build_object('outcome', p_outcome));
  select count(*) into v_failures from public.audit_logs
  where actor_user_id = p_actor and action = 'erp_reset.reauth_failed' and event_timestamp > now() - interval '15 minutes';
  return jsonb_build_object('recent_failures', v_failures);
end;
$$;

create or replace function public.erp_reset_attempt_allowed(p_actor uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('allowed', n < 5, 'recent_failures', n)
  from (select count(*)::int n from public.audit_logs
        where actor_user_id = p_actor and action = 'erp_reset.reauth_failed' and event_timestamp > now() - interval '15 minutes') x;
$$;

-- The reset. p_actor is the user id the Edge Function took from the VERIFIED
-- session; this function is executable by service_role only.
create or replace function public.erp_reset_execute(p_actor uuid, p_request_id uuid, p_confirmation text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company     uuid;
  v_run         public.erp_reset_runs;
  v_plan        jsonb;
  v_before      jsonb;
  v_after       jsonb;
  v_fp_before   jsonb;
  v_fp_after    jsonb;
  v_kept_sup    bigint;
  v_deleted     jsonb := '{}'::jsonb;
  v_total       bigint := 0;
  v_n           bigint;
  v_step        bigint;
  v_status      text;
  v_error       text;
  v_verify      jsonb := '{}'::jsonb;
  v_problems    text[] := '{}';
  v_current     text;
  r             record;
begin
  if p_actor is null or p_request_id is null then
    raise exception 'Actor and request id are required.' using errcode = '22023';
  end if;
  if p_confirmation is distinct from 'RESET ERP' then
    raise exception 'Type RESET ERP to confirm.' using errcode = '22023';
  end if;

  select company_id into v_company from public.profiles where id = p_actor;
  if v_company is null then
    insert into public.audit_logs (company_id, actor_user_id, action, resource_type, metadata)
    values (null, p_actor, 'erp_reset.denied', 'erp_reset', jsonb_build_object('reason', 'no company'));
    return jsonb_build_object('status', 'DENIED', 'error', 'Your account is not assigned to a company.');
  end if;

  -- Idempotency: a request that already ran returns its stored result.
  select * into v_run from public.erp_reset_runs where company_id = v_company and request_id = p_request_id;
  if found then
    return jsonb_build_object('status', v_run.status, 'run_id', v_run.id, 'request_id', v_run.request_id, 'replayed', true,
      'deleted', v_run.deleted_counts, 'deleted_total', v_run.deleted_total, 'preserved', v_run.preserved_counts,
      'blockers', v_run.blockers, 'verification', v_run.verification, 'error', v_run.error_message);
  end if;

  -- One reset per company at a time.
  if not pg_try_advisory_xact_lock(hashtextextended('erp_reset:' || v_company::text, 0)) then
    return jsonb_build_object('status', 'IN_PROGRESS', 'error', 'Another ERP reset of this company is running. Wait for it to finish.');
  end if;
  -- Re-check after the lock (a concurrent duplicate may have just finished).
  select * into v_run from public.erp_reset_runs where company_id = v_company and request_id = p_request_id;
  if found then
    return jsonb_build_object('status', v_run.status, 'run_id', v_run.id, 'request_id', v_run.request_id, 'replayed', true,
      'deleted', v_run.deleted_counts, 'deleted_total', v_run.deleted_total, 'preserved', v_run.preserved_counts,
      'blockers', v_run.blockers, 'verification', v_run.verification, 'error', v_run.error_message);
  end if;

  -- Authorization, re-checked now, with the actor's profile and role rows
  -- locked so they cannot be changed until this transaction ends.
  perform 1 from public.profiles where id = p_actor for share;
  perform 1 from public.user_roles where user_id = p_actor and company_id = v_company for share;
  if not private.erp_reset_actor_ok(p_actor, v_company) then
    insert into public.audit_logs (company_id, actor_user_id, action, resource_type, metadata)
    values (v_company, p_actor, 'erp_reset.denied', 'erp_reset', jsonb_build_object('reason', 'not an active Super Admin with system.reset_data'));
    return jsonb_build_object('status', 'DENIED', 'error', 'Only an active Super Admin with the system.reset_data permission can reset ERP data.');
  end if;

  v_plan := private.erp_reset_plan(v_company);
  v_before := v_plan -> 'counts';
  v_kept_sup := (v_plan ->> 'kept_suppliers')::bigint;

  if jsonb_array_length(v_plan -> 'blockers') > 0 then
    v_status := 'BLOCKED';
    v_error := 'Nothing was deleted. Some records are protected by the database and cannot be deleted.';
  else
    v_fp_before := private.erp_reset_schema_fingerprint();
    begin
      for r in select t.table_name from private.erp_reset_tables() t order by t.ord, t.table_name loop
        v_current := r.table_name;
        if r.table_name = 'suppliers' then
          delete from public.suppliers s
          where s.company_id = v_company
            and not exists (select 1 from public.products p where p.company_id = v_company and p.preferred_supplier_id = s.id);
          get diagnostics v_n = row_count;
        elsif r.table_name = 'customer_purchase_orders' then
          -- Revisions reference their previous revision: delete newest first.
          v_n := 0;
          loop
            delete from public.customer_purchase_orders o
            where o.company_id = v_company
              and not exists (select 1 from public.customer_purchase_orders x where x.previous_revision_id = o.id);
            get diagnostics v_step = row_count;
            exit when v_step = 0;
            v_n := v_n + v_step;
          end loop;
        else
          execute format('delete from public.%I where company_id = $1', r.table_name) using v_company;
          get diagnostics v_n = row_count;
        end if;
        if v_n > 0 then
          v_deleted := v_deleted || jsonb_build_object(r.table_name, v_n);
        end if;
        v_total := v_total + v_n;
      end loop;
      v_current := null;

      -- Verification inside the transaction; any problem rolls back the deletions.
      v_after := private.erp_reset_counts(v_company);
      for r in select t.table_name from private.erp_reset_tables() t loop
        v_n := (v_after -> 'deleted' ->> r.table_name)::bigint;
        if v_n <> (case when r.table_name = 'suppliers' then v_kept_sup else 0 end) then
          v_problems := v_problems || format('%s still has %s rows', r.table_name, v_n);
        end if;
      end loop;
      for r in select k.table_name from private.erp_reset_kept_tables() k loop
        if (v_after -> 'kept' ->> r.table_name) is distinct from (v_before -> 'kept' ->> r.table_name) then
          v_problems := v_problems || format('kept table %s changed from %s to %s rows', r.table_name,
            v_before -> 'kept' ->> r.table_name, v_after -> 'kept' ->> r.table_name);
        end if;
      end loop;
      v_fp_after := private.erp_reset_schema_fingerprint();
      if v_fp_after is distinct from v_fp_before then
        v_problems := v_problems || format('schema objects changed: %s -> %s', v_fp_before, v_fp_after);
      end if;
      if not private.erp_reset_actor_ok(p_actor, v_company) then
        v_problems := v_problems || 'the initiating Super Admin lost access'::text;
      end if;
      if cardinality(v_problems) > 0 then
        raise exception 'ERP_RESET_VERIFICATION_FAILED: %', array_to_string(v_problems, '; ');
      end if;
      v_verify := jsonb_build_object('allowlist_empty', true, 'kept_tables_unchanged', true, 'schema_unchanged', true,
        'actor_access_valid', true, 'schema', v_fp_after);
      v_status := 'COMPLETED';
    exception when others then
      -- Every deletion of this attempt has been rolled back with the block.
      v_status := 'FAILED';
      v_error := left(case when v_current is not null then format('Deleting %s failed: %s', v_current, sqlerrm) else sqlerrm end, 2000);
      v_deleted := '{}'::jsonb;
      v_total := 0;
      v_verify := jsonb_build_object('rolled_back', true);
    end;
  end if;

  insert into public.erp_reset_runs (company_id, request_id, requested_by, status, deleted_counts, deleted_total, preserved_counts,
                                     blockers, verification, error_message)
  values (v_company, p_request_id, p_actor, v_status, v_deleted, v_total, v_before -> 'kept',
          v_plan -> 'blockers', v_verify, v_error)
  returning * into v_run;

  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_company, p_actor, 'erp_reset.' || lower(v_status), 'erp_reset', v_run.id::text,
          jsonb_build_object('request_id', p_request_id, 'status', v_status, 'deleted_total', v_total, 'deleted', v_deleted,
            'blocker_tables', coalesce((select jsonb_agg(b ->> 'table') from jsonb_array_elements(v_plan -> 'blockers') b), '[]'::jsonb),
            'error', left(v_error, 500)));

  return jsonb_build_object('status', v_status, 'run_id', v_run.id, 'request_id', p_request_id, 'replayed', false,
    'deleted', v_deleted, 'deleted_total', v_total, 'preserved', v_before -> 'kept', 'kept_suppliers', v_kept_sup,
    'blockers', v_plan -> 'blockers', 'verification', v_verify, 'error', v_error);
end;
$$;

-- Independent check after the reset transaction has committed.
create or replace function public.erp_reset_verify(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company  uuid;
  v_counts   jsonb;
  v_kept_sup bigint;
  v_left     jsonb := '{}'::jsonb;
  v_n        bigint;
  r          record;
begin
  select company_id into v_company from public.profiles where id = p_actor;
  if v_company is null then
    return jsonb_build_object('ok', false, 'problems', jsonb_build_array('The initiating user has no company.'));
  end if;
  v_counts := private.erp_reset_counts(v_company);
  v_kept_sup := private.erp_reset_kept_supplier_count(v_company);
  for r in select t.table_name from private.erp_reset_tables() t loop
    v_n := (v_counts -> 'deleted' ->> r.table_name)::bigint - case when r.table_name = 'suppliers' then v_kept_sup else 0 end;
    if v_n <> 0 then v_left := v_left || jsonb_build_object(r.table_name, v_n); end if;
  end loop;
  return jsonb_build_object(
    'ok', v_left = '{}'::jsonb and private.erp_reset_actor_ok(p_actor, v_company)
          and exists (select 1 from public.companies where id = v_company and is_active),
    'actor_access_valid', private.erp_reset_actor_ok(p_actor, v_company),
    'company_active', exists (select 1 from public.companies where id = v_company and is_active),
    'super_admins', (select count(*) from public.user_roles ur join public.roles ro on ro.id = ur.role_id
                     join public.profiles p on p.id = ur.user_id and p.is_active
                     where ur.company_id = v_company and ro.code = 'SUPER_ADMIN'),
    'company_settings', (v_counts -> 'kept' ->> 'company_settings')::bigint,
    'remaining', v_left,
    'kept', v_counts -> 'kept');
end;
$$;

revoke all on function public.erp_reset_execute(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.erp_reset_verify(uuid) from public, anon, authenticated;
revoke all on function public.erp_reset_record_attempt(uuid, text) from public, anon, authenticated;
revoke all on function public.erp_reset_attempt_allowed(uuid) from public, anon, authenticated;
grant execute on function public.erp_reset_execute(uuid, uuid, text) to service_role;
grant execute on function public.erp_reset_verify(uuid) to service_role;
grant execute on function public.erp_reset_record_attempt(uuid, text) to service_role;
grant execute on function public.erp_reset_attempt_allowed(uuid) to service_role;

revoke all on function private.erp_reset_tables() from public, anon, authenticated;
revoke all on function private.erp_reset_kept_tables() from public, anon, authenticated;
revoke all on function private.erp_reset_document_entity_types() from public, anon, authenticated;
revoke all on function private.erp_reset_guard_reason(text) from public, anon, authenticated;
revoke all on function private.erp_reset_guarded_tables() from public, anon, authenticated;
revoke all on function private.erp_reset_schema_fingerprint() from public, anon, authenticated;
revoke all on function private.erp_reset_counts(uuid) from public, anon, authenticated;
revoke all on function private.erp_reset_actor_ok(uuid, uuid) from public, anon, authenticated;
revoke all on function private.erp_reset_kept_supplier_count(uuid) from public, anon, authenticated;
revoke all on function private.erp_reset_plan(uuid) from public, anon, authenticated;
