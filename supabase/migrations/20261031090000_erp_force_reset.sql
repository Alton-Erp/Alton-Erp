-- =============================================================================
-- Force reset ("delete everything") of one company's business data
--
-- The standard reset (20261030090000_erp_reset.sql) stops when protected
-- history exists: posted stock, issued invoices, payments, BOMs, event
-- histories, import history, approval decisions. This migration adds a
-- separate, reviewed DEMO / DEVELOPMENT purge path that can delete those
-- records too, for ONE company, under these conditions (all server-side):
--
--   1. Environment approval. A database owner (SQL Editor / postgres) must
--      first approve the company for a force purge with
--      private.erp_force_reset_approve(company code, company id, environment
--      DEVELOPMENT | DEMO | TEST, approver, reason, hours). API roles cannot
--      create or see approvals. An approval expires (max 72 h), can be revoked,
--      and is consumed by the first completed force reset.
--   2. Backup record. The Super Admin records the backup taken before the
--      reset (method, reference, time, restore tested, "the backup is outside
--      this database"). This is an ADMINISTRATOR ATTESTATION: the database
--      cannot inspect a Supabase backup. Valid for 24 h, single use.
--   3. Fresh password re-authentication, done by the force-reset-erp-data
--      Edge Function, which then issues a one-time ticket (2 minutes, stored
--      hashed) and calls erp_force_reset_execute WITH THE USER'S OWN JWT, so
--      the database identifies the user with auth.uid().
--   4. Typed confirmations: DELETE ALL COMPANY DATA and the company code.
--   5. Server-side re-check under lock: active Super Admin of that company
--      with system.reset_data, approval, backup, reviewed deletion plan.
--
-- How protected rows are deleted (no guard is disabled)
--   The append-only / posted-document guard functions get ONE extra early
--   return: a DELETE is allowed when the transaction-local setting
--   app.erp_force_purge names a purge session row that
--     * was inserted by erp_force_reset_execute in the SAME transaction
--       (txid_current()),
--     * belongs to the SAME company as the row being deleted, and
--     * the table is in the reviewed purge list (never erp_reset_runs or
--       audit_logs; the audit-log guard is not changed at all).
--   Session rows can only be written by that function (no API grants). UPDATEs
--   and TRUNCATE stay forbidden. Outside a force purge every guard behaves
--   exactly as before. Triggers, RLS and constraints are never disabled.
--
-- Plan
--   Every public table is discovered from the catalogue and classified:
--   purge (reviewed list), retained (reviewed list), or unreviewed. An
--   unreviewed table with a company_id column blocks the reset until it is
--   classified; any foreign key from a non-purge table into a purge table
--   blocks it too. The deletion order is computed from the live foreign keys
--   (children first; self-references are deleted leaf-first).
--
-- Verification (inside the transaction, else everything rolls back)
--   all purge tables empty for the company; other companies' rows unchanged;
--   retained tables unchanged (audit log may only grow); schema objects
--   unchanged; initiating Super Admin intact; Super Admin count unchanged.
--   After commit the Edge Function removes the company's files from Storage
--   and erp_force_reset_verify checks database and Storage again.
--
-- Also: demo_presentation_data (present only in some databases) is classified
-- as RESETTABLE company data when it has a company_id column (standard and
-- force reset); without company_id it blocks the force reset.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Standard reset classification updates
-- -----------------------------------------------------------------------------
-- Same 75 tables as 20261030090000, plus demo_presentation_data when it exists
-- with a company_id column.
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
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
    (2, 'customer_returns', 'Sales & fulfilment', 'Customer returns'),
    (2, 'fulfilment_lines', 'Sales & fulfilment', 'Fulfilment lines'),
    (2, 'outsourcing_orders', 'Outsourcing', 'Outsourcing orders'),
    (2, 'production_orders', 'Production & BOMs', 'Production orders'),
    (2, 'purchase_orders', 'Supplier purchasing', 'Supplier purchase orders'),
    (2, 'sales_invoices', 'Billing & receivables', 'Sales invoices'),
    (3, 'boms', 'Production & BOMs', 'Bills of materials'),
    (3, 'fulfilments', 'Sales & fulfilment', 'Fulfilments and dispatches'),
    (3, 'inventory_transactions', 'Inventory', 'Stock ledger'),
    (3, 'sales_order_lines', 'Sales & fulfilment', 'Sales order lines'),
    (3, 'stock_reservations', 'Inventory', 'Stock reservations'),
    (3, 'suppliers', 'Customers & suppliers', 'Suppliers'),
    (4, 'customer_purchase_order_lines', 'Customer purchase orders', 'Customer PO lines'),
    (4, 'inventory_batches', 'Inventory', 'Stock batches / lots'),
    (4, 'sales_orders', 'Sales & fulfilment', 'Sales orders'),
    (5, 'customer_purchase_orders', 'Customer purchase orders', 'Customer purchase orders'),
    (6, 'customer_po_import_batches', 'Customer purchase orders', 'Customer PO import batches'),
    (6, 'customers', 'Customers & suppliers', 'Customers')
  ) t (ord, table_name, category, label)
  union all
  select 0, 'demo_presentation_data', 'Demo data', 'Demo presentation data'
  where exists (select 1 from pg_catalog.pg_attribute a
                where a.attrelid = to_regclass('public.demo_presentation_data') and a.attname = 'company_id' and not a.attisdropped);
$$;

-- Same kept list as before plus the backup records added below.
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
    ('erp_reset_backup_attestations', 'Reset backup records', true),
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

-- -----------------------------------------------------------------------------
-- Reset history: mode and references (columns only; rows stay append-only)
-- -----------------------------------------------------------------------------
alter table public.erp_reset_runs add column if not exists mode text not null default 'STANDARD';
alter table public.erp_reset_runs add column if not exists approval_id uuid;
alter table public.erp_reset_runs add column if not exists backup_id uuid;
alter table public.erp_reset_runs add column if not exists storage_objects jsonb not null default '[]'::jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'erp_reset_runs_mode_check' and conrelid = 'public.erp_reset_runs'::regclass) then
    alter table public.erp_reset_runs add constraint erp_reset_runs_mode_check check (mode in ('STANDARD', 'FORCE'));
  end if;
end;
$$;
comment on column public.erp_reset_runs.mode is 'STANDARD (protected history blocks) or FORCE (approved demo/development purge).';
comment on column public.erp_reset_runs.storage_objects is 'Storage files of the company that the completed force reset scheduled for removal after commit.';

-- -----------------------------------------------------------------------------
-- Backup records (append-only, administrator attestation)
-- -----------------------------------------------------------------------------
create table if not exists public.erp_reset_backup_attestations (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete restrict,
  recorded_by           uuid not null,
  backup_method         text not null check (backup_method in ('SUPABASE_SCHEDULED', 'SUPABASE_PITR', 'PG_DUMP', 'OTHER')),
  backup_reference      text not null check (length(btrim(backup_reference)) between 3 and 300),
  backup_taken_at       timestamptz not null,
  restore_tested        boolean not null check (restore_tested),
  external_acknowledged boolean not null check (external_acknowledged),
  verification_method   text not null default 'ADMINISTRATOR_ATTESTED' check (verification_method = 'ADMINISTRATOR_ATTESTED'),
  notes                 text check (notes is null or length(notes) <= 500),
  recorded_at           timestamptz not null default now()
);

comment on table public.erp_reset_backup_attestations is
  'Backups a Super Admin declared before a force reset. Administrator attestation: the database cannot inspect a Supabase backup. Append-only.';

create index if not exists erp_reset_backup_attestations_company_idx on public.erp_reset_backup_attestations (company_id, recorded_at desc);

alter table public.erp_reset_backup_attestations enable row level security;
revoke all on public.erp_reset_backup_attestations from anon, authenticated;
grant select on public.erp_reset_backup_attestations to authenticated;

drop policy if exists erp_reset_backup_attestations_select on public.erp_reset_backup_attestations;
create policy erp_reset_backup_attestations_select on public.erp_reset_backup_attestations for select to authenticated
  using (private.has_permission(company_id, 'system.reset_data'));

drop trigger if exists erp_reset_backup_attestations_append_only on public.erp_reset_backup_attestations;
create trigger erp_reset_backup_attestations_append_only before update or delete on public.erp_reset_backup_attestations
  for each row execute function private.prevent_history_mutation();

-- -----------------------------------------------------------------------------
-- Private state (no API role can read or write these tables)
-- -----------------------------------------------------------------------------
create table if not exists private.erp_force_reset_approvals (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete restrict,
  company_code   text not null,
  environment    text not null check (environment in ('DEVELOPMENT', 'DEMO', 'TEST')),
  approved_by    text not null check (length(btrim(approved_by)) between 3 and 120),
  reason         text not null check (length(btrim(reason)) between 10 and 500),
  approved_db_user text not null default current_user,
  approved_at    timestamptz not null default now(),
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  revoke_reason  text check (revoke_reason is null or length(revoke_reason) <= 500),
  check (expires_at > approved_at and expires_at <= approved_at + interval '72 hours')
);

create table if not exists private.erp_force_reset_tickets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  company_id  uuid not null,
  token_hash  text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index if not exists erp_force_reset_tickets_user_idx on private.erp_force_reset_tickets (user_id, company_id);

create table if not exists private.erp_force_purge_sessions (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  actor       uuid not null,
  request_id  uuid not null,
  txid        bigint not null,
  created_at  timestamptz not null default now()
);

revoke all on private.erp_force_reset_approvals from public, anon, authenticated, service_role;
revoke all on private.erp_force_reset_tickets from public, anon, authenticated, service_role;
revoke all on private.erp_force_purge_sessions from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Classification for the force reset
-- -----------------------------------------------------------------------------
-- Reviewed purge list: the standard list plus the master data the standard
-- reset keeps (products, categories, warehouses, locations, documents).
create or replace function private.erp_force_reset_tables()
returns table (table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select t.table_name, t.category, t.label from private.erp_reset_tables() t
  union all
  select * from (values
    ('products', 'Products & catalogue', 'Products'),
    ('product_categories', 'Products & catalogue', 'Product categories'),
    ('warehouses', 'Warehouses & locations', 'Warehouses'),
    ('inventory_locations', 'Warehouses & locations', 'Warehouse locations'),
    ('documents', 'Documents', 'Documents (except company-level documents)'),
    ('document_versions', 'Documents', 'Document file versions')
  ) x (table_name, category, label);
$$;

-- Reviewed retained list (what survives a force reset).
create or replace function private.erp_force_reset_retained_tables()
returns table (table_name text, label text, company_scoped boolean, reason text)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('companies', 'Company record', true, 'Needed to sign in to the ERP.'),
    ('company_settings', 'Company settings', true, 'Needed for the application to operate.'),
    ('profiles', 'User profiles', true, 'Every user account is kept.'),
    ('user_roles', 'Role assignments', true, 'Every role assignment is kept, including all Super Admins.'),
    ('roles', 'Roles', false, 'Access control.'),
    ('permissions', 'Permissions', false, 'Access control.'),
    ('role_permissions', 'Role permissions', false, 'Access control.'),
    ('audit_logs', 'Audit log', true, 'Security record; it also records this reset.'),
    ('erp_reset_runs', 'Reset history', true, 'Immutable record of every reset attempt.'),
    ('erp_reset_backup_attestations', 'Reset backup records', true, 'Record of the backup taken before the reset.'),
    ('invoice_settings', 'Invoice settings', true, 'Configuration.'),
    ('billing_number_sequences', 'Billing number series', true, 'Configuration; numbers continue and never repeat numbers in the audit log.'),
    ('inventory_number_sequences', 'Inventory number series', true, 'Configuration; numbers continue and never repeat numbers in the audit log.'),
    ('approval_workflows', 'Approval workflows', true, 'Configuration.'),
    ('approval_workflow_stages', 'Approval workflow stages', true, 'Configuration.'),
    ('notification_preferences', 'Notification preferences', true, 'User settings.'),
    ('notification_sync_state', 'Notification sync state', true, 'System state.'),
    ('error_events', 'System error log', true, 'Diagnostic and security record.'),
    ('amazon_settings', 'Amazon settings', true, 'Configuration.'),
    ('amazon_connections', 'Amazon connections', true, 'Integration configuration (no business data).')
  ) t (table_name, label, company_scoped, reason);
$$;

-- Rows of the company a force reset deletes from a purge table (alias t, $1 = company).
create or replace function private.erp_force_reset_row_filter(p_table text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_table
    when 'documents' then 't.company_id = $1 and t.related_entity_type <> ''COMPANY'''
    when 'document_versions' then 't.company_id = $1 and not exists (select 1 from public.documents d where d.id = t.document_id and d.related_entity_type = ''COMPANY'')'
    else 't.company_id = $1'
  end;
$$;

-- Extra condition for a self-referencing table: delete only rows no other
-- row of the same table still references (repeated until nothing is left).
create or replace function private.erp_force_reset_self_fk_clause(p_table text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(string_agg(format(' and not exists (select 1 from public.%I x where %s)', p_table,
    (select string_agg(format('x.%I = t.%I', ca.attname, pa.attname), ' and ' order by u.i)
     from unnest(k.conkey, k.confkey) with ordinality u (ck, pk, i)
     join pg_catalog.pg_attribute ca on ca.attrelid = k.conrelid and ca.attnum = u.ck
     join pg_catalog.pg_attribute pa on pa.attrelid = k.confrelid and pa.attnum = u.pk)), ''), '')
  from pg_catalog.pg_constraint k
  where k.contype = 'f' and k.conrelid = to_regclass('public.' || p_table) and k.confrelid = k.conrelid;
$$;

-- Deletion order from the live foreign keys: ord 0 = nothing in the purge set
-- references it; a parent always has a higher ord than each child. ord >= 100
-- means a cycle (reported as a blocker).
create or replace function private.erp_force_reset_order()
returns table (table_name text, ord int)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive s as (
    select f.table_name from private.erp_force_reset_tables() f where to_regclass('public.' || f.table_name) is not null
  ), e as (
    select distinct ch.relname::text collate "default" as child, pa.relname::text collate "default" as parent
    from pg_catalog.pg_constraint k
    join pg_catalog.pg_class ch on ch.oid = k.conrelid join pg_catalog.pg_namespace cn on cn.oid = ch.relnamespace
    join pg_catalog.pg_class pa on pa.oid = k.confrelid join pg_catalog.pg_namespace pn on pn.oid = pa.relnamespace
    where k.contype = 'f' and cn.nspname = 'public' and pn.nspname = 'public' and ch.oid <> pa.oid
      and ch.relname in (select s.table_name from s) and pa.relname in (select s.table_name from s)
  ), w (t, d) as (
    select s.table_name, 0 from s
    union
    select e.parent, w.d + 1 from w join e on e.child = w.t where w.d < 100
  )
  select w.t, max(w.d)::int from w group by w.t;
$$;

-- Purge tables protected by a BEFORE DELETE row trigger (from the catalogue).
create or replace function private.erp_force_reset_guarded_tables()
returns table (table_name text, guard_function text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (c.relname) c.relname::text, p.proname::text
  from pg_catalog.pg_trigger tg
  join pg_catalog.pg_class c on c.oid = tg.tgrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_proc p on p.oid = tg.tgfoid
  where n.nspname = 'public' and not tg.tgisinternal
    and (tg.tgtype & 1) <> 0 and (tg.tgtype & 2) <> 0 and (tg.tgtype & 8) <> 0
    and c.relname in (select f.table_name from private.erp_force_reset_tables() f)
  order by c.relname, p.proname;
$$;

-- -----------------------------------------------------------------------------
-- The guard exemption
-- -----------------------------------------------------------------------------
-- True only inside erp_force_reset_execute's own transaction, for a row of the
-- company being purged, in a reviewed purge table.
create or replace function private.erp_force_purge_allows(p_table text, p_company uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select p_company is not null
    and coalesce(current_setting('app.erp_force_purge', true), '') <> ''
    and p_table in (select f.table_name from private.erp_force_reset_tables() f)
    and exists (select 1 from private.erp_force_purge_sessions s
                where s.id::text = current_setting('app.erp_force_purge', true)
                  and s.company_id = p_company
                  and s.txid = txid_current());
$$;

revoke all on function private.erp_force_purge_allows(text, uuid) from public, anon;
-- Guard triggers run as the role that issues the statement, so the roles that
-- can reach a guard need to call this check (it only ever returns true inside
-- a force purge session).
grant execute on function private.erp_force_purge_allows(text, uuid) to authenticated, service_role;

-- Each guard below is unchanged except for the first IF block.
create or replace function private.prevent_ledger_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
  raise exception 'Posted stock transactions cannot be changed or deleted. Post a reversal instead.' using errcode = '42501';
end;
$$;

create or replace function private.prevent_history_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
  raise exception 'History records cannot be changed or deleted.' using errcode = '42501';
end;
$$;

create or replace function private.prevent_import_history_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
  raise exception 'Import history is append-only.' using errcode = '42501';
end;
$$;

create or replace function private.prevent_approval_decision_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
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
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
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
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
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
$$;

create or replace function private.guard_payment_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, (to_jsonb(old) ->> 'company_id')::uuid) then return old; end if;
  end if;
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
$$;

revoke all on function private.prevent_ledger_mutation() from public, anon, authenticated;
revoke all on function private.prevent_history_mutation() from public, anon, authenticated;
revoke all on function private.guard_posted_document() from public, anon, authenticated;
revoke all on function private.guard_bom_write() from public, anon, authenticated;
revoke all on function private.guard_bom_item_write() from public, anon, authenticated;
revoke all on function private.guard_invoice_change() from public, anon, authenticated;
revoke all on function private.guard_invoice_line_change() from public, anon, authenticated;
revoke all on function private.guard_payment_change() from public, anon, authenticated;
revoke all on function private.guard_note_change() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Counts, files, approvals, backups
-- -----------------------------------------------------------------------------
-- {"purge": {table: rows of the company}, "other": {table: rows of every other
-- company}, "retained": {table: rows}, "company_documents": n}
create or replace function private.erp_force_reset_counts(p_company uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_purge    jsonb := '{}'::jsonb;
  v_other    jsonb := '{}'::jsonb;
  v_retained jsonb := '{}'::jsonb;
  v_n        bigint;
  r          record;
begin
  for r in select f.table_name from private.erp_force_reset_tables() f where to_regclass('public.' || f.table_name) is not null loop
    execute format('select count(*) from public.%I t where %s', r.table_name, private.erp_force_reset_row_filter(r.table_name)) into v_n using p_company;
    v_purge := v_purge || jsonb_build_object(r.table_name, v_n);
    execute format('select count(*) from public.%I t where t.company_id is distinct from $1', r.table_name) into v_n using p_company;
    v_other := v_other || jsonb_build_object(r.table_name, v_n);
  end loop;
  for r in select k.table_name, k.company_scoped from private.erp_force_reset_retained_tables() k loop
    if r.table_name = 'companies' then
      select count(*) into v_n from public.companies where id = p_company;
    elsif r.company_scoped then
      execute format('select count(*) from public.%I where company_id = $1', r.table_name) into v_n using p_company;
    else
      execute format('select count(*) from public.%I', r.table_name) into v_n;
    end if;
    v_retained := v_retained || jsonb_build_object(r.table_name, v_n);
  end loop;
  select count(*) into v_n from public.documents where company_id = p_company and related_entity_type = 'COMPANY';
  return jsonb_build_object('purge', v_purge, 'other', v_other, 'retained', v_retained, 'company_documents', v_n);
end;
$$;

-- Files of the company in Storage that a force reset removes: everything under
-- "<company id>/" in product-images and documents, except the files of
-- company-level documents (kept).
create or replace function private.erp_force_reset_storage_objects(p_company uuid)
returns table (bucket text, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.bucket_id::text, o.name::text
  from storage.objects o
  where o.bucket_id in ('product-images', 'documents')
    and o.name like p_company::text || '/%'
    and not exists (select 1 from public.document_versions v join public.documents d on d.id = v.document_id
                    where d.company_id = p_company and d.related_entity_type = 'COMPANY' and v.storage_path = o.name)
  order by 1, 2;
$$;

-- Active approval: not expired, not revoked, not used by a completed force reset.
create or replace function private.erp_force_reset_active_approval(p_company uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', a.id, 'environment', a.environment, 'approved_by', a.approved_by, 'reason', a.reason,
           'approved_at', a.approved_at, 'expires_at', a.expires_at)
  from private.erp_force_reset_approvals a
  where a.company_id = p_company and a.revoked_at is null and a.expires_at > now()
    and not exists (select 1 from public.erp_reset_runs r where r.approval_id = a.id and r.status = 'COMPLETED')
  order by a.approved_at desc
  limit 1;
$$;

-- Usable backup record: recorded and taken within 24 hours, not used by a
-- completed force reset. p_backup_id null = the latest usable one.
create or replace function private.erp_force_reset_valid_backup(p_company uuid, p_backup_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', b.id, 'backup_method', b.backup_method, 'backup_reference', b.backup_reference,
           'backup_taken_at', b.backup_taken_at, 'recorded_at', b.recorded_at, 'recorded_by', b.recorded_by,
           'restore_tested', b.restore_tested, 'external_acknowledged', b.external_acknowledged,
           'verification_method', b.verification_method, 'valid_until', least(b.recorded_at, b.backup_taken_at) + interval '24 hours',
           'changes_since_backup', (select count(*) from public.audit_logs l where l.company_id = p_company
                                    and l.event_timestamp > b.backup_taken_at
                                    and l.action not like 'erp\_reset.%' and l.action not like 'erp\_force\_reset.%'))
  from public.erp_reset_backup_attestations b
  where b.company_id = p_company
    and (p_backup_id is null or b.id = p_backup_id)
    and b.recorded_at > now() - interval '24 hours'
    and b.backup_taken_at > now() - interval '24 hours'
    and not exists (select 1 from public.erp_reset_runs r where r.backup_id = b.id and r.status = 'COMPLETED')
  order by b.recorded_at desc
  limit 1;
$$;

-- Active Super Admins of the company.
create or replace function private.erp_force_reset_super_admins(p_company uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) from public.user_roles ur join public.roles ro on ro.id = ur.role_id
  join public.profiles p on p.id = ur.user_id and p.is_active
  where ur.company_id = p_company and ro.code = 'SUPER_ADMIN';
$$;

-- -----------------------------------------------------------------------------
-- The plan (inventory of every public table)
-- -----------------------------------------------------------------------------
create or replace function private.erp_force_reset_plan(p_company uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_counts     jsonb := private.erp_force_reset_counts(p_company);
  v_tables     jsonb := '[]'::jsonb;
  v_retained   jsonb := '[]'::jsonb;
  v_blockers   jsonb := '[]'::jsonb;
  v_unaffected jsonb := '[]'::jsonb;
  v_total      bigint := 0;
  v_protected  bigint := 0;
  v_n          bigint;
  v_discovered int;
  v_demo       text;
  r            record;
begin
  -- Purge tables with rows, order and protection.
  for r in
    select f.table_name, f.category, f.label, o.ord, g.guard_function
    from private.erp_force_reset_tables() f
    join private.erp_force_reset_order() o on o.table_name = f.table_name
    left join private.erp_force_reset_guarded_tables() g on g.table_name = f.table_name
    order by o.ord, f.table_name
  loop
    v_n := (v_counts -> 'purge' ->> r.table_name)::bigint;
    v_total := v_total + v_n;
    if r.guard_function is not null then v_protected := v_protected + v_n; end if;
    v_tables := v_tables || jsonb_build_object('table', r.table_name, 'category', r.category, 'label', r.label, 'rows', v_n,
      'order', r.ord, 'protected', r.guard_function is not null,
      'protection', case when r.guard_function is null then null else private.erp_reset_guard_reason(r.guard_function) end);
    if r.ord >= 100 then
      v_blockers := v_blockers || jsonb_build_object('kind', 'FOREIGN_KEY_CYCLE', 'table', r.table_name, 'label', r.label, 'rows', v_n,
        'reason', 'The tables reference each other in a cycle, so no safe deletion order exists. Review the schema.');
    end if;
  end loop;

  -- Retained tables.
  for r in select k.table_name, k.label, k.reason from private.erp_force_reset_retained_tables() k loop
    v_retained := v_retained || jsonb_build_object('table', r.table_name, 'label', r.label, 'reason', r.reason,
      'rows', (v_counts -> 'retained' ->> r.table_name)::bigint);
  end loop;
  v_retained := v_retained || jsonb_build_object('table', 'documents', 'label', 'Company-level documents and their files',
    'reason', 'Documents attached to the company itself (for example KYC or contracts) are kept.', 'rows', (v_counts ->> 'company_documents')::bigint);

  -- Every other public table, discovered from the catalogue.
  for r in
    select c.relname::text as table_name,
           exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped) as scoped
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and c.relname not in (select f.table_name from private.erp_force_reset_tables() f)
      and c.relname not in (select k.table_name from private.erp_force_reset_retained_tables() k)
    order by 1
  loop
    if r.table_name = 'demo_presentation_data' then
      v_blockers := v_blockers || jsonb_build_object('kind', 'DEMO_TABLE_NOT_COMPANY_SCOPED', 'table', r.table_name, 'label', 'Demo presentation data',
        'rows', null, 'reason', 'demo_presentation_data has no company_id column, so its rows cannot be limited to this company. Add company_id or clear it separately.');
    elsif r.scoped then
      execute format('select count(*) from public.%I where company_id = $1', r.table_name) into v_n using p_company;
      v_blockers := v_blockers || jsonb_build_object('kind', 'UNREVIEWED_COMPANY_TABLE', 'table', r.table_name, 'label', r.table_name, 'rows', v_n,
        'reason', 'This company-scoped table is not in the reviewed purge or retained list. Classify it in a migration before a force reset.');
    else
      v_unaffected := v_unaffected || to_jsonb(r.table_name);
    end if;
  end loop;

  -- Foreign keys from any table outside the purge set into it.
  for r in
    select distinct cn.nspname || '.' || ch.relname as child, pa.relname::text as parent, k.conname::text as fk
    from pg_catalog.pg_constraint k
    join pg_catalog.pg_class ch on ch.oid = k.conrelid join pg_catalog.pg_namespace cn on cn.oid = ch.relnamespace
    join pg_catalog.pg_class pa on pa.oid = k.confrelid join pg_catalog.pg_namespace pn on pn.oid = pa.relnamespace
    where k.contype = 'f' and pn.nspname = 'public'
      and pa.relname in (select f.table_name from private.erp_force_reset_tables() f)
      and not (cn.nspname = 'public' and ch.relname in (select f.table_name from private.erp_force_reset_tables() f))
    order by 1, 2
  loop
    v_blockers := v_blockers || jsonb_build_object('kind', 'RETAINED_TABLE_REFERENCE', 'table', r.child, 'label', r.child, 'rows', null,
      'reason', format('%s references %s (%s); deleting %s would break or change retained rows.', r.child, r.parent, r.fk, r.parent));
  end loop;

  select count(*) into v_discovered from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p');
  v_demo := case
    when to_regclass('public.demo_presentation_data') is null then 'NOT_PRESENT'
    when exists (select 1 from private.erp_force_reset_tables() f where f.table_name = 'demo_presentation_data') then 'RESETTABLE'
    else 'NOT_COMPANY_SCOPED' end;

  return jsonb_build_object(
    'tables', v_tables,
    'delete_total', v_total,
    'protected_total', v_protected,
    'retained', v_retained,
    'blockers', v_blockers,
    'unaffected_tables', v_unaffected,
    'discovered_tables', v_discovered,
    'demo_presentation_data', v_demo,
    'counts', v_counts);
end;
$$;

-- -----------------------------------------------------------------------------
-- Public API: preview, backup record (signed-in Super Admin)
-- -----------------------------------------------------------------------------
create or replace function public.erp_force_reset_preview(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.current_company_id();
  v_plan     jsonb;
  v_approval jsonb;
  v_backup   jsonb;
  v_storage  jsonb;
  v_co       public.companies;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated. Open the force reset preview from the signed-in ERP application (auth.uid() is empty in the SQL Editor).'
      using errcode = '42501';
  end if;
  if v_company is null or p_company_id is distinct from v_company then
    raise exception 'You can only preview a force reset of the company your account belongs to.' using errcode = '42501';
  end if;
  if not private.has_role(v_company, 'SUPER_ADMIN') or not private.has_permission(v_company, 'system.reset_data') then
    raise exception 'Only a Super Admin with the system.reset_data permission can reset ERP data.' using errcode = '42501';
  end if;

  select * into v_co from public.companies where id = v_company;
  v_plan := private.erp_force_reset_plan(v_company);
  v_approval := private.erp_force_reset_active_approval(v_company);
  v_backup := private.erp_force_reset_valid_backup(v_company, null);
  select jsonb_build_object(
           'product_images', count(*) filter (where s.bucket = 'product-images'),
           'documents', count(*) filter (where s.bucket = 'documents'))
    into v_storage from private.erp_force_reset_storage_objects(v_company) s;

  return (v_plan - 'counts') || jsonb_build_object(
    'company', jsonb_build_object('id', v_co.id, 'code', v_co.company_code, 'name', coalesce(v_co.display_name, v_co.legal_name)),
    'approval', v_approval,
    'backup', v_backup,
    'storage', v_storage,
    'gates', jsonb_build_object(
      'authorized', true,
      'environment_approved', v_approval is not null,
      'backup_verified', v_backup is not null,
      'plan_reviewed', jsonb_array_length(v_plan -> 'blockers') = 0),
    'can_execute', v_approval is not null and v_backup is not null and jsonb_array_length(v_plan -> 'blockers') = 0,
    'generated_at', now());
end;
$$;

revoke all on function public.erp_force_reset_preview(uuid) from public, anon;
grant execute on function public.erp_force_reset_preview(uuid) to authenticated;

create or replace function public.erp_force_reset_record_backup(
  p_company_id uuid,
  p_backup_method text,
  p_backup_reference text,
  p_backup_taken_at timestamptz,
  p_restore_tested boolean,
  p_external_acknowledged boolean,
  p_notes text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_ref     text := btrim(coalesce(p_backup_reference, ''));
  v_row     public.erp_reset_backup_attestations;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;
  if v_company is null or p_company_id is distinct from v_company
     or not private.has_role(v_company, 'SUPER_ADMIN') or not private.has_permission(v_company, 'system.reset_data') then
    raise exception 'Only a Super Admin of this company with the system.reset_data permission can record a reset backup.' using errcode = '42501';
  end if;
  if p_backup_method is null or p_backup_method not in ('SUPABASE_SCHEDULED', 'SUPABASE_PITR', 'PG_DUMP', 'OTHER') then
    raise exception 'Choose how the backup was taken.' using errcode = 'P0001';
  end if;
  if length(v_ref) < 3 or length(v_ref) > 300 then
    raise exception 'Enter the backup reference (for example the backup time shown in Supabase, or the dump file name).' using errcode = 'P0001';
  end if;
  if v_ref ~* '(password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]' or v_ref ~ '://[^/\s:@]+:[^/\s@]+@' then
    raise exception 'Do not enter passwords, keys or connection strings with credentials. Enter only a backup name, time or file name.' using errcode = 'P0001';
  end if;
  if p_backup_taken_at is null or p_backup_taken_at > now() + interval '5 minutes' then
    raise exception 'The backup time cannot be in the future.' using errcode = 'P0001';
  end if;
  if p_backup_taken_at < now() - interval '24 hours' then
    raise exception 'The backup must have been taken in the last 24 hours. Take a new backup first.' using errcode = 'P0001';
  end if;
  if p_restore_tested is not true then
    raise exception 'Confirm that you checked the backup can be restored.' using errcode = 'P0001';
  end if;
  if p_external_acknowledged is not true then
    raise exception 'Confirm that the backup is outside this database and is not undone by the reset.' using errcode = 'P0001';
  end if;
  if p_notes is not null and length(p_notes) > 500 then
    raise exception 'Notes can be at most 500 characters.' using errcode = 'P0001';
  end if;

  insert into public.erp_reset_backup_attestations (company_id, recorded_by, backup_method, backup_reference, backup_taken_at,
                                                    restore_tested, external_acknowledged, notes)
  values (v_company, auth.uid(), p_backup_method, v_ref, p_backup_taken_at, true, true, nullif(btrim(p_notes), ''))
  returning * into v_row;

  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_company, auth.uid(), 'erp_force_reset.backup_recorded', 'erp_reset', v_row.id::text,
          jsonb_build_object('backup_method', v_row.backup_method, 'backup_reference', v_row.backup_reference,
                             'backup_taken_at', v_row.backup_taken_at, 'verification_method', v_row.verification_method));

  return private.erp_force_reset_valid_backup(v_company, v_row.id);
end;
$$;

revoke all on function public.erp_force_reset_record_backup(uuid, text, text, timestamptz, boolean, boolean, text) from public, anon;
grant execute on function public.erp_force_reset_record_backup(uuid, text, text, timestamptz, boolean, boolean, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Environment approval (database owner only, e.g. in the SQL Editor)
-- -----------------------------------------------------------------------------
create or replace function private.erp_force_reset_approve(
  p_company_code text,
  p_company_id uuid,
  p_environment text,
  p_approved_by text,
  p_reason text,
  p_valid_hours int default 24)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row private.erp_force_reset_approvals;
begin
  if not exists (select 1 from public.companies where id = p_company_id and company_code = p_company_code) then
    raise exception 'Company code % and id % do not belong to the same company.', p_company_code, p_company_id using errcode = '22023';
  end if;
  if p_environment is null or p_environment not in ('DEVELOPMENT', 'DEMO', 'TEST') then
    raise exception 'Environment must be DEVELOPMENT, DEMO or TEST. A force reset is not available for production business data.' using errcode = '22023';
  end if;
  if p_valid_hours is null or p_valid_hours < 1 or p_valid_hours > 72 then
    raise exception 'An approval is valid for 1 to 72 hours.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_approved_by, ''))) < 3 then
    raise exception 'Name the person approving the force reset.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'Give the reason for the force reset (at least 10 characters).' using errcode = '22023';
  end if;

  insert into private.erp_force_reset_approvals (company_id, company_code, environment, approved_by, reason, expires_at)
  values (p_company_id, p_company_code, p_environment, btrim(p_approved_by), btrim(p_reason), now() + make_interval(hours => p_valid_hours))
  returning * into v_row;

  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_company_id, null, 'erp_force_reset.environment_approved', 'erp_reset', v_row.id::text,
          jsonb_build_object('environment', v_row.environment, 'approved_by', v_row.approved_by, 'reason', v_row.reason,
                             'expires_at', v_row.expires_at, 'database_user', v_row.approved_db_user));

  return jsonb_build_object('approval_id', v_row.id, 'company_code', v_row.company_code, 'environment', v_row.environment,
                            'expires_at', v_row.expires_at);
end;
$$;

create or replace function private.erp_force_reset_revoke_approval(p_approval_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row private.erp_force_reset_approvals;
begin
  update private.erp_force_reset_approvals
     set revoked_at = now(), revoke_reason = left(coalesce(p_reason, 'revoked'), 500)
   where id = p_approval_id and revoked_at is null
  returning * into v_row;
  if not found then
    raise exception 'No active approval with id %.', p_approval_id using errcode = '22023';
  end if;
  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_row.company_id, null, 'erp_force_reset.environment_revoked', 'erp_reset', v_row.id::text,
          jsonb_build_object('reason', v_row.revoke_reason, 'database_user', current_user));
  return jsonb_build_object('approval_id', v_row.id, 'revoked_at', v_row.revoked_at);
end;
$$;

-- -----------------------------------------------------------------------------
-- Re-authentication ticket (issued by the Edge Function after the password check)
-- -----------------------------------------------------------------------------
create or replace function public.erp_force_reset_issue_ticket(p_actor uuid, p_company uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if p_actor is null or p_company is null or not private.erp_reset_actor_ok(p_actor, p_company) then
    raise exception 'Only an active Super Admin of this company with system.reset_data can start a force reset.' using errcode = '42501';
  end if;
  delete from private.erp_force_reset_tickets where expires_at < now() - interval '1 day';
  insert into private.erp_force_reset_tickets (user_id, company_id, token_hash, expires_at)
  values (p_actor, p_company, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), now() + interval '2 minutes');
  return jsonb_build_object('ticket', v_token, 'expires_in_seconds', 120);
end;
$$;

-- -----------------------------------------------------------------------------
-- Execute
-- -----------------------------------------------------------------------------
create or replace function private.erp_force_reset_run_result(p_run public.erp_reset_runs, p_replayed boolean)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('status', p_run.status, 'mode', p_run.mode, 'run_id', p_run.id, 'request_id', p_run.request_id,
    'replayed', p_replayed, 'deleted', p_run.deleted_counts, 'deleted_total', p_run.deleted_total,
    'preserved', p_run.preserved_counts, 'blockers', p_run.blockers, 'verification', p_run.verification,
    'storage_objects', jsonb_array_length(p_run.storage_objects), 'error', p_run.error_message,
    'started_at', p_run.started_at, 'finished_at', p_run.finished_at);
$$;

create or replace function public.erp_force_reset_execute(
  p_company_id uuid,
  p_request_id uuid,
  p_confirmation text,
  p_company_code text,
  p_backup_id uuid,
  p_reauth_ticket text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor     uuid := auth.uid();
  v_company   uuid;
  v_co        public.companies;
  v_run       public.erp_reset_runs;
  v_ticket    uuid;
  v_approval  jsonb;
  v_backup    jsonb;
  v_plan      jsonb;
  v_blockers  jsonb;
  v_before    jsonb;
  v_after     jsonb;
  v_fp_before jsonb;
  v_fp_after  jsonb;
  v_sa_before bigint;
  v_storage   jsonb := '[]'::jsonb;
  v_deleted   jsonb := '{}'::jsonb;
  v_total     bigint := 0;
  v_n         bigint;
  v_step      bigint;
  v_status    text;
  v_error     text;
  v_verify    jsonb := '{}'::jsonb;
  v_problems  text[] := '{}';
  v_current   text;
  v_sql       text;
  v_self      text;
  v_session   uuid;
  r           record;
begin
  if v_actor is null then
    raise exception 'Not authenticated. Run the force reset from the signed-in ERP application.' using errcode = '42501';
  end if;
  if p_company_id is null or p_request_id is null then
    raise exception 'Company and request id are required.' using errcode = '22023';
  end if;
  if p_confirmation is distinct from 'DELETE ALL COMPANY DATA' then
    raise exception 'Type DELETE ALL COMPANY DATA to confirm.' using errcode = '22023';
  end if;

  select company_id into v_company from public.profiles where id = v_actor;
  if v_company is null or v_company <> p_company_id then
    insert into public.audit_logs (company_id, actor_user_id, action, resource_type, metadata)
    values (v_company, v_actor, 'erp_force_reset.denied', 'erp_reset', jsonb_build_object('reason', 'company mismatch', 'requested_company', p_company_id));
    return jsonb_build_object('status', 'DENIED', 'error', 'You can only reset the company your account belongs to.');
  end if;

  -- Idempotency: a request that already ran returns its stored result.
  select * into v_run from public.erp_reset_runs where company_id = v_company and request_id = p_request_id;
  if found then
    return private.erp_force_reset_run_result(v_run, true);
  end if;

  -- One reset (standard or force) per company at a time.
  if not pg_try_advisory_xact_lock(hashtextextended('erp_reset:' || v_company::text, 0)) then
    return jsonb_build_object('status', 'IN_PROGRESS', 'error', 'Another ERP reset of this company is running. Wait for it to finish.');
  end if;
  select * into v_run from public.erp_reset_runs where company_id = v_company and request_id = p_request_id;
  if found then
    return private.erp_force_reset_run_result(v_run, true);
  end if;

  -- Authorization under lock.
  perform 1 from public.profiles where id = v_actor for share;
  perform 1 from public.user_roles where user_id = v_actor and company_id = v_company for share;
  if not private.erp_reset_actor_ok(v_actor, v_company) then
    insert into public.audit_logs (company_id, actor_user_id, action, resource_type, metadata)
    values (v_company, v_actor, 'erp_force_reset.denied', 'erp_reset', jsonb_build_object('reason', 'not an active Super Admin with system.reset_data'));
    return jsonb_build_object('status', 'DENIED', 'error', 'Only an active Super Admin with the system.reset_data permission can reset ERP data.');
  end if;

  -- Fresh password re-authentication (one-time ticket from the Edge Function).
  update private.erp_force_reset_tickets t
     set used_at = now()
   where t.user_id = v_actor and t.company_id = v_company and t.used_at is null and t.expires_at > now()
     and t.token_hash = encode(sha256(convert_to(coalesce(p_reauth_ticket, ''), 'UTF8')), 'hex')
  returning t.id into v_ticket;
  if v_ticket is null then
    insert into public.audit_logs (company_id, actor_user_id, action, resource_type, metadata)
    values (v_company, v_actor, 'erp_force_reset.denied', 'erp_reset', jsonb_build_object('reason', 're-authentication missing, already used or expired'));
    return jsonb_build_object('status', 'DENIED', 'code', 'REAUTH_REQUIRED',
      'error', 'Password re-authentication is required. Enter your password again in the force reset dialog.');
  end if;

  select * into v_co from public.companies where id = v_company;
  if upper(btrim(coalesce(p_company_code, ''))) is distinct from upper(v_co.company_code) then
    insert into public.audit_logs (company_id, actor_user_id, action, resource_type, metadata)
    values (v_company, v_actor, 'erp_force_reset.denied', 'erp_reset', jsonb_build_object('reason', 'company code confirmation did not match'));
    return jsonb_build_object('status', 'DENIED', 'error', format('The company code does not match. Type %s to confirm.', v_co.company_code));
  end if;

  -- Gates and plan.
  v_approval := private.erp_force_reset_active_approval(v_company);
  v_backup := private.erp_force_reset_valid_backup(v_company, p_backup_id);
  v_plan := private.erp_force_reset_plan(v_company);
  v_blockers := v_plan -> 'blockers';
  if v_approval is null then
    v_blockers := v_blockers || jsonb_build_object('kind', 'ENVIRONMENT_NOT_APPROVED', 'table', null, 'label', 'Environment approval', 'rows', null,
      'reason', 'No active approval for a force purge of this company. A database owner must approve it in the SQL Editor (docs/ERP_RESET.md).');
  end if;
  if v_backup is null then
    v_blockers := v_blockers || jsonb_build_object('kind', 'BACKUP_NOT_VERIFIED', 'table', null, 'label', 'Backup', 'rows', null,
      'reason', 'No usable backup record (recorded and taken in the last 24 hours, not used by a completed reset). Record the backup first.');
  end if;
  v_before := v_plan -> 'counts';

  if jsonb_array_length(v_blockers) > 0 then
    v_status := 'BLOCKED';
    v_error := 'Nothing was deleted. The force reset requirements are not met.';
  else
    v_fp_before := private.erp_reset_schema_fingerprint();
    v_sa_before := private.erp_force_reset_super_admins(v_company);
    begin
      select coalesce(jsonb_agg(jsonb_build_object('bucket', s.bucket, 'name', s.name)), '[]'::jsonb)
        into v_storage from private.erp_force_reset_storage_objects(v_company) s;

      insert into private.erp_force_purge_sessions (company_id, actor, request_id, txid)
      values (v_company, v_actor, p_request_id, txid_current())
      returning id into v_session;
      perform set_config('app.erp_force_purge', v_session::text, true);

      for r in select o.table_name from private.erp_force_reset_order() o order by o.ord, o.table_name loop
        v_current := r.table_name;
        v_self := private.erp_force_reset_self_fk_clause(r.table_name);
        v_sql := format('delete from public.%I t where %s%s', r.table_name, private.erp_force_reset_row_filter(r.table_name), v_self);
        v_n := 0;
        loop
          execute v_sql using v_company;
          get diagnostics v_step = row_count;
          v_n := v_n + v_step;
          exit when v_self = '' or v_step = 0;
        end loop;
        if v_n > 0 then
          v_deleted := v_deleted || jsonb_build_object(r.table_name, v_n);
        end if;
        v_total := v_total + v_n;
      end loop;
      v_current := null;

      perform set_config('app.erp_force_purge', '', true);
      delete from private.erp_force_purge_sessions where id = v_session;

      -- Verification inside the transaction; any problem rolls everything back.
      v_after := private.erp_force_reset_counts(v_company);
      for r in select key, value from jsonb_each(v_after -> 'purge') loop
        if (r.value)::bigint <> 0 then
          v_problems := v_problems || format('%s still has %s rows', r.key, r.value);
        end if;
      end loop;
      if (v_after -> 'other') is distinct from (v_before -> 'other') then
        v_problems := v_problems || 'rows of other companies changed'::text;
      end if;
      for r in select key, value from jsonb_each(v_before -> 'retained') loop
        if r.key = 'audit_logs' then
          if (v_after -> 'retained' ->> r.key)::bigint < (r.value)::bigint then
            v_problems := v_problems || 'audit log rows were removed'::text;
          end if;
        elsif (v_after -> 'retained' -> r.key) is distinct from r.value then
          v_problems := v_problems || format('retained table %s changed from %s to %s rows', r.key, r.value, v_after -> 'retained' -> r.key);
        end if;
      end loop;
      if (v_after ->> 'company_documents') is distinct from (v_before ->> 'company_documents') then
        v_problems := v_problems || 'company-level documents changed'::text;
      end if;
      v_fp_after := private.erp_reset_schema_fingerprint();
      if v_fp_after is distinct from v_fp_before then
        v_problems := v_problems || format('schema objects changed: %s -> %s', v_fp_before, v_fp_after);
      end if;
      if not private.erp_reset_actor_ok(v_actor, v_company) then
        v_problems := v_problems || 'the initiating Super Admin lost access'::text;
      end if;
      if private.erp_force_reset_super_admins(v_company) <> v_sa_before then
        v_problems := v_problems || 'the number of Super Admins changed'::text;
      end if;
      if not exists (select 1 from public.companies where id = v_company and is_active) then
        v_problems := v_problems || 'the company record is missing or inactive'::text;
      end if;
      if cardinality(v_problems) > 0 then
        raise exception 'ERP_FORCE_RESET_VERIFICATION_FAILED: %', array_to_string(v_problems, '; ');
      end if;
      v_verify := jsonb_build_object('purge_tables_empty', true, 'other_companies_unchanged', true, 'retained_tables_unchanged', true,
        'schema_unchanged', true, 'actor_access_valid', true, 'super_admins', v_sa_before, 'schema', v_fp_after);
      v_status := 'COMPLETED';
    exception when others then
      -- Every deletion of this attempt has been rolled back with the block.
      perform set_config('app.erp_force_purge', '', true);
      v_status := 'FAILED';
      v_error := left(case when v_current is not null then format('Deleting %s failed: %s', v_current, sqlerrm) else sqlerrm end, 2000);
      v_deleted := '{}'::jsonb;
      v_total := 0;
      v_storage := '[]'::jsonb;
      v_verify := jsonb_build_object('rolled_back', true);
    end;
  end if;

  insert into public.erp_reset_runs (company_id, request_id, requested_by, status, mode, approval_id, backup_id, deleted_counts, deleted_total,
                                     preserved_counts, blockers, verification, storage_objects, error_message)
  values (v_company, p_request_id, v_actor, v_status, 'FORCE', (v_approval ->> 'id')::uuid, (v_backup ->> 'id')::uuid, v_deleted, v_total,
          v_before -> 'retained', v_blockers, v_verify, v_storage, v_error)
  returning * into v_run;

  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_company, v_actor, 'erp_force_reset.' || lower(v_status), 'erp_reset', v_run.id::text,
          jsonb_build_object('request_id', p_request_id, 'status', v_status, 'mode', 'FORCE', 'company_code', v_co.company_code,
            'environment', v_approval ->> 'environment', 'approval_id', v_approval ->> 'id', 'backup_id', v_backup ->> 'id',
            'backup_reference', v_backup ->> 'backup_reference', 'deleted_total', v_total, 'deleted', v_deleted,
            'storage_objects', jsonb_array_length(v_storage),
            'blockers', coalesce((select jsonb_agg(b ->> 'kind') from jsonb_array_elements(v_blockers) b), '[]'::jsonb),
            'error', left(v_error, 500)));

  return private.erp_force_reset_run_result(v_run, false) || jsonb_build_object('company', jsonb_build_object('id', v_co.id, 'code', v_co.company_code));
end;
$$;

revoke all on function public.erp_force_reset_execute(uuid, uuid, text, text, uuid, text) from public, anon;
grant execute on function public.erp_force_reset_execute(uuid, uuid, text, text, uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- After commit: failure record, Storage clean-up record, verification
-- (service_role only: the force-reset-erp-data Edge Function)
-- -----------------------------------------------------------------------------
-- The execute call returned an error (for example a statement timeout, which
-- rolls back everything). Records FAILED unless the request has a stored run,
-- which is returned instead (it may have committed).
create or replace function public.erp_force_reset_record_failure(p_actor uuid, p_company uuid, p_request_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run public.erp_reset_runs;
begin
  if not exists (select 1 from public.profiles where id = p_actor and company_id = p_company) then
    return jsonb_build_object('status', 'DENIED', 'error', 'The user does not belong to this company.');
  end if;
  select * into v_run from public.erp_reset_runs where company_id = p_company and request_id = p_request_id;
  if found then
    return private.erp_force_reset_run_result(v_run, true);
  end if;
  begin
    insert into public.erp_reset_runs (company_id, request_id, requested_by, status, mode, verification, error_message)
    values (p_company, p_request_id, p_actor, 'FAILED', 'FORCE', jsonb_build_object('rolled_back', true),
            left('The force reset did not finish and was rolled back by the database: ' || coalesce(p_reason, 'unknown error'), 2000))
    returning * into v_run;
  exception when unique_violation then
    select * into v_run from public.erp_reset_runs where company_id = p_company and request_id = p_request_id;
    return private.erp_force_reset_run_result(v_run, true);
  end;
  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_company, p_actor, 'erp_force_reset.failed', 'erp_reset', v_run.id::text,
          jsonb_build_object('request_id', p_request_id, 'status', 'FAILED', 'mode', 'FORCE', 'error', left(v_run.error_message, 500)));
  return private.erp_force_reset_run_result(v_run, false);
end;
$$;

create or replace function public.erp_force_reset_record_storage_cleanup(p_actor uuid, p_run_id uuid, p_removed int, p_failed int, p_error text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid;
begin
  select company_id into v_company from public.erp_reset_runs where id = p_run_id and mode = 'FORCE' and requested_by = p_actor;
  if v_company is null then
    raise exception 'Unknown force reset run.' using errcode = '22023';
  end if;
  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_company, p_actor, 'erp_force_reset.storage_cleanup', 'erp_reset', p_run_id::text,
          jsonb_build_object('removed', coalesce(p_removed, 0), 'failed', coalesce(p_failed, 0), 'error', left(p_error, 500)));
end;
$$;

create or replace function public.erp_force_reset_verify(p_actor uuid, p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_run      public.erp_reset_runs;
  v_counts   jsonb;
  v_left     jsonb := '{}'::jsonb;
  v_storage  jsonb;
  v_files    bigint;
  v_actor_ok boolean;
  v_active   boolean;
  r          record;
begin
  select * into v_run from public.erp_reset_runs where id = p_run_id and mode = 'FORCE';
  if not found or v_run.status <> 'COMPLETED' then
    return jsonb_build_object('ok', false, 'problems', jsonb_build_array('No completed force reset with this id.'));
  end if;
  if not exists (select 1 from public.profiles where id = p_actor and company_id = v_run.company_id) then
    return jsonb_build_object('ok', false, 'problems', jsonb_build_array('The user does not belong to the reset company.'));
  end if;
  v_counts := private.erp_force_reset_counts(v_run.company_id);
  for r in select key, value from jsonb_each(v_counts -> 'purge') loop
    if (r.value)::bigint <> 0 then v_left := v_left || jsonb_build_object(r.key, r.value); end if;
  end loop;
  select count(*), coalesce(jsonb_agg(jsonb_build_object('bucket', x.bucket, 'name', x.name)) filter (where x.rn <= 1000), '[]'::jsonb)
    into v_files, v_storage
  from (select s.bucket, s.name, row_number() over (order by s.bucket, s.name) rn from private.erp_force_reset_storage_objects(v_run.company_id) s) x;
  v_actor_ok := private.erp_reset_actor_ok(p_actor, v_run.company_id);
  v_active := exists (select 1 from public.companies where id = v_run.company_id and is_active);
  return jsonb_build_object(
    'ok', v_left = '{}'::jsonb and v_files = 0 and v_actor_ok and v_active,
    'remaining', v_left,
    'storage_remaining', v_files,
    'storage_objects', v_storage,
    'actor_access_valid', v_actor_ok,
    'company_active', v_active,
    'super_admins', private.erp_force_reset_super_admins(v_run.company_id),
    'retained', v_counts -> 'retained',
    'company_documents', v_counts -> 'company_documents',
    'checked_at', now());
end;
$$;

revoke all on function public.erp_force_reset_issue_ticket(uuid, uuid) from public, anon, authenticated;
revoke all on function public.erp_force_reset_record_failure(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.erp_force_reset_record_storage_cleanup(uuid, uuid, int, int, text) from public, anon, authenticated;
revoke all on function public.erp_force_reset_verify(uuid, uuid) from public, anon, authenticated;
grant execute on function public.erp_force_reset_issue_ticket(uuid, uuid) to service_role;
grant execute on function public.erp_force_reset_record_failure(uuid, uuid, uuid, text) to service_role;
grant execute on function public.erp_force_reset_record_storage_cleanup(uuid, uuid, int, int, text) to service_role;
grant execute on function public.erp_force_reset_verify(uuid, uuid) to service_role;

revoke all on function private.erp_force_reset_tables() from public, anon, authenticated, service_role;
revoke all on function private.erp_force_reset_retained_tables() from public, anon, authenticated, service_role;
revoke all on function private.erp_force_reset_row_filter(text) from public, anon, authenticated, service_role;
revoke all on function private.erp_force_reset_self_fk_clause(text) from public, anon, authenticated, service_role;
revoke all on function private.erp_force_reset_order() from public, anon, authenticated, service_role;
revoke all on function private.erp_force_reset_guarded_tables() from public, anon, authenticated, service_role;
revoke all on function private.erp_force_reset_counts(uuid) from public, anon, authenticated, service_role;
revoke all on function private.erp_force_reset_storage_objects(uuid) from public, anon, authenticated, service_role;
revoke all on function private.erp_force_reset_active_approval(uuid) from public, anon, authenticated, service_role;
revoke all on function private.erp_force_reset_valid_backup(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.erp_force_reset_super_admins(uuid) from public, anon, authenticated, service_role;
revoke all on function private.erp_force_reset_plan(uuid) from public, anon, authenticated, service_role;
revoke all on function private.erp_force_reset_approve(text, uuid, text, text, text, int) from public, anon, authenticated, service_role;
revoke all on function private.erp_force_reset_revoke_approval(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.erp_force_reset_run_result(public.erp_reset_runs, boolean) from public, anon, authenticated, service_role;
revoke all on function private.erp_reset_tables() from public, anon, authenticated;
revoke all on function private.erp_reset_kept_tables() from public, anon, authenticated;
