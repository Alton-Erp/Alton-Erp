-- =============================================================================
-- ERP RESET VERIFICATION
--
-- Executable checks for migration 20261030090000_erp_reset.sql:
-- classification of every table against the live catalogue (foreign keys,
-- delete guards), permissions (Super Admin only, execute = service_role only),
-- the impact preview, a BLOCKED reset (protected history: nothing deleted),
-- a COMPLETED reset (business data gone, everything else unchanged, other
-- company untouched, initiating and other Super Admins intact), idempotent
-- replay, a FAILED reset (rolled back), unclassified-table and document
-- blockers, audit records, append-only history and the password-attempt limit.
--
--   locally:      npm run test:db   (DB_SUITE=erp_reset for this suite only)
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction with its own companies (ERA / ERB / ERC) and users
-- (@er.example.invalid) and ALWAYS ends by raising
--   ERP_RESET_VERIFICATION_RESULT passed=N failed=M
-- so every test row is rolled back. It deletes only rows of its own companies.
-- =============================================================================

begin;

create schema rls_test;
grant usage on schema rls_test to anon, authenticated, service_role;

create table rls_test.results (id serial primary key, name text not null, passed boolean not null, detail text);
create table rls_test.ids (key text primary key, id uuid not null);
create table rls_test.vars (key text primary key, value jsonb);
grant select, insert on rls_test.results to anon, authenticated, service_role;
grant usage on sequence rls_test.results_id_seq to anon, authenticated, service_role;
grant select on rls_test.ids to anon, authenticated, service_role;
grant select, insert, update on rls_test.vars to anon, authenticated, service_role;

create function rls_test.id(p_key text) returns uuid language sql stable as $$ select id from rls_test.ids where key = p_key $$;
create function rls_test.ok(p_name text, p_cond boolean, p_detail text default null) returns void language plpgsql as $$
begin insert into rls_test.results (name, passed, detail) values (p_name, coalesce(p_cond, false), p_detail); end $$;
create function rls_test.call(p_sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin execute p_sql into r; return coalesce(r, '{}'::jsonb);
exception when others then return jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate); end $$;
create function rls_test.set(p_key text, p_value jsonb) returns jsonb language plpgsql as $$
begin insert into rls_test.vars values (p_key, p_value) on conflict (key) do update set value = excluded.value; return p_value; end $$;
create function rls_test.get(p_key text) returns jsonb language sql stable as $$ select value from rls_test.vars where key = p_key $$;
create function rls_test.expect_call_ok(p_name text, p_key text, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.set(p_key, r); perform rls_test.ok(p_name, not (r ? 'error' and r ->> 'sqlstate' is not null), r::text); return r; end $$;
create function rls_test.expect_call_error(p_name text, p_sql text, p_pattern text default null) returns void language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.ok(p_name, r ->> 'sqlstate' is not null and (p_pattern is null or r ->> 'error' ilike '%' || p_pattern || '%'), r::text); end $$;
create function rls_test.claims(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', rls_test.id(p_key), 'role', 'authenticated')::text, true) $$;

-- Owner-side probes (bypass RLS).
create function rls_test.n(p_table text, p_company uuid) returns bigint language plpgsql stable security definer as $$
declare v bigint; begin execute format('select count(*) from public.%I where company_id = $1', p_table) into v using p_company; return v; end $$;
create function rls_test.company_rows(p_company uuid) returns jsonb language plpgsql stable security definer as $$
declare v jsonb := '{}'::jsonb; v_n bigint; r record;
begin
  for r in select c.relname::text t from pg_class c join pg_namespace s on s.oid = c.relnamespace
           where s.nspname = 'public' and c.relkind = 'r'
             and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = c.relname and column_name = 'company_id')
           order by 1 loop
    execute format('select count(*) from public.%I where company_id = $1', r.t) into v_n using p_company;
    v := v || jsonb_build_object(r.t, v_n);
  end loop;
  return v;
end $$;
create function rls_test.audits(p_company uuid, p_action text) returns bigint language sql stable security definer as $$
  select count(*) from public.audit_logs where company_id = p_company and action = p_action $$;
create function rls_test.fingerprint() returns jsonb language sql stable security definer as $$ select private.erp_reset_schema_fingerprint() $$;

grant execute on all functions in schema rls_test to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fixtures (database owner)
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5e900-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5e900-0000-4000-8000-0000000000b1'),
  ('company_c', 'e7e5e900-0000-4000-8000-0000000000c1'),
  ('a_sa',   'e7e5e900-0000-4000-8000-000000000001'),  -- Super Admin A
  ('b_sa',   'e7e5e900-0000-4000-8000-000000000002'),  -- Super Admin B (initiator)
  ('b_sa2',  'e7e5e900-0000-4000-8000-000000000003'),  -- second Super Admin B
  ('b_adm',  'e7e5e900-0000-4000-8000-000000000004'),  -- Admin B (settings.manage, not Super Admin)
  ('b_im',   'e7e5e900-0000-4000-8000-000000000005'),  -- Inventory Manager B
  ('c_sa',   'e7e5e900-0000-4000-8000-000000000006'),  -- Super Admin C
  ('a_prod', 'e7e5e900-0000-4000-8000-0000000000d1'), ('b_prod', 'e7e5e900-0000-4000-8000-0000000000d2'),
  ('b_prod2','e7e5e900-0000-4000-8000-0000000000d3'),
  ('a_cust', 'e7e5e900-0000-4000-8000-0000000000e1'), ('b_cust', 'e7e5e900-0000-4000-8000-0000000000e2'),
  ('b_cust2','e7e5e900-0000-4000-8000-0000000000e3'), ('c_cust', 'e7e5e900-0000-4000-8000-0000000000e4'),
  ('b_cust3','e7e5e900-0000-4000-8000-0000000000e5'),
  ('b_sup_keep', 'e7e5e900-0000-4000-8000-0000000000f1'), ('b_sup_del', 'e7e5e900-0000-4000-8000-0000000000f2'),
  ('b_cpo1', 'e7e5e900-0000-4000-8000-0000000000f3'), ('b_cpo2', 'e7e5e900-0000-4000-8000-0000000000f4'),
  ('b_cpo3', 'e7e5e900-0000-4000-8000-0000000000f5'),
  ('b_job',  'e7e5e900-0000-4000-8000-0000000000f6'),
  ('req_a',  'e7e5e900-0000-4000-8000-000000000101'), ('req_b',  'e7e5e900-0000-4000-8000-000000000102'),
  ('req_b2', 'e7e5e900-0000-4000-8000-000000000103'), ('req_b3', 'e7e5e900-0000-4000-8000-000000000104'),
  ('req_b4', 'e7e5e900-0000-4000-8000-000000000105'), ('req_c',  'e7e5e900-0000-4000-8000-000000000106');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code) values
  (rls_test.id('company_a'), 'Reset Test A', 'Reset Test A', 'ERA'),
  (rls_test.id('company_b'), 'Reset Test B', 'Reset Test B', 'ERB'),
  (rls_test.id('company_c'), 'Reset Test C', 'Reset Test C', 'ERC');

insert into auth.users (id, email)
select id, key || '@er.example.invalid' from rls_test.ids where key in ('a_sa', 'b_sa', 'b_sa2', 'b_adm', 'b_im', 'c_sa');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = rls_test.id('a_sa');
update public.profiles set company_id = rls_test.id('company_b'), is_active = true
  where id in (rls_test.id('b_sa'), rls_test.id('b_sa2'), rls_test.id('b_adm'), rls_test.id('b_im'));
update public.profiles set company_id = rls_test.id('company_c'), is_active = true where id = rls_test.id('c_sa');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('a_sa'),  rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('b_sa'),  rls_test.id('company_b'), rls_test.id('role_super_admin')),
  (rls_test.id('b_sa2'), rls_test.id('company_b'), rls_test.id('role_super_admin')),
  (rls_test.id('b_adm'), rls_test.id('company_b'), rls_test.id('role_admin')),
  (rls_test.id('b_im'),  rls_test.id('company_b'), rls_test.id('role_inventory_manager')),
  (rls_test.id('c_sa'),  rls_test.id('company_c'), rls_test.id('role_super_admin'));

insert into public.company_settings (company_id, setting_key, setting_value)
values (rls_test.id('company_b'), 'reporting.default_period', '"this_month"'::jsonb)
on conflict do nothing;

insert into public.suppliers (id, company_id, supplier_code, legal_name) values
  (rls_test.id('b_sup_keep'), rls_test.id('company_b'), 'SUP-KEEP', 'Kept supplier'),
  (rls_test.id('b_sup_del'),  rls_test.id('company_b'), 'SUP-DEL',  'Deleted supplier');

insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, preferred_supplier_id) values
  (rls_test.id('a_prod'),  rls_test.id('company_a'), 'ER-A1', 'Reset product A', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', null),
  (rls_test.id('b_prod'),  rls_test.id('company_b'), 'ER-B1', 'Reset product B', 'COMPONENT', 'OUTSOURCED', 'PCS', rls_test.id('b_sup_keep')),
  (rls_test.id('b_prod2'), rls_test.id('company_b'), 'ER-B2', 'Reset product B2', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', null);

insert into public.customers (id, company_id, customer_code, customer_name) values
  (rls_test.id('a_cust'),  rls_test.id('company_a'), 'ERA-C1', 'Customer of A'),
  (rls_test.id('b_cust'),  rls_test.id('company_b'), 'ERB-C1', 'Customer of B'),
  (rls_test.id('b_cust2'), rls_test.id('company_b'), 'ERB-C2', 'Second customer of B'),
  (rls_test.id('c_cust'),  rls_test.id('company_c'), 'ERC-C1', 'Customer of C');

insert into public.customer_product_codes (company_id, customer_id, customer_sku, product_id)
values (rls_test.id('company_b'), rls_test.id('b_cust'), 'CUST-SKU-1', rls_test.id('b_prod'));

-- Customer PO revision chain (rev 2 references rev 1).
insert into public.customer_purchase_orders (id, company_id, po_reference, customer_name_snapshot, customer_key, customer_po_number, po_date, revision, is_current)
values (rls_test.id('b_cpo1'), rls_test.id('company_b'), 'ERB-CPO-1', 'Customer of B', 'ERB-C1', 'PO-77', current_date, 1, false);
insert into public.customer_purchase_orders (id, company_id, po_reference, customer_name_snapshot, customer_key, customer_po_number, po_date, revision, previous_revision_id)
values (rls_test.id('b_cpo2'), rls_test.id('company_b'), 'ERB-CPO-1R2', 'Customer of B', 'ERB-C1', 'PO-77', current_date, 2, rls_test.id('b_cpo1'));

insert into public.notifications (company_id, recipient_user_id, notification_type, title, message)
values (rls_test.id('company_b'), rls_test.id('b_im'), 'LOW_STOCK', 'Low stock', 'ER-B1 is low');
insert into public.inventory_alerts (company_id, alert_key, alert_type, severity, product_id)
values (rls_test.id('company_b'), 'LOW_STOCK:' || rls_test.id('b_prod'), 'LOW_STOCK', 'WARNING', rls_test.id('b_prod'));
insert into public.amazon_sync_jobs (id, company_id, api, job_type) values (rls_test.id('b_job'), rls_test.id('company_b'), 'CSV', 'SALES_IMPORT');
insert into public.amazon_sync_errors (company_id, job_id, api, operation, message)
values (rls_test.id('company_b'), rls_test.id('b_job'), 'CSV', 'parse', 'row 3 invalid');
insert into public.inventory_requests (company_id, idempotency_key, operation) values (rls_test.id('company_b'), gen_random_uuid(), 'TEST');
-- A document on a kept product: kept, not a blocker.
insert into public.documents (company_id, document_type, title, related_entity_type, related_entity_id, related_reference)
values (rls_test.id('company_b'), 'DRAWING', 'Drawing of ER-B1', 'PRODUCT', rls_test.id('b_prod'), 'ER-B1');

-- Company A: protected history (an append-only customer PO import batch).
insert into public.customer_po_import_batches (company_id, file_name, validation_status, import_status)
values (rls_test.id('company_a'), 'orders.xlsx', 'VALID', 'IMPORTED');

-- Company C: a customer with an attached document (documents are never deleted).
insert into public.documents (company_id, document_type, title, related_entity_type, related_entity_id, related_reference)
values (rls_test.id('company_c'), 'KYC', 'KYC of ERC-C1', 'CUSTOMER', rls_test.id('c_cust'), 'ERC-C1');

-- ---------------------------------------------------------------------------
-- 1. Classification against the live catalogue
-- ---------------------------------------------------------------------------
select rls_test.ok('catalogue: every public table is either resettable or kept',
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind in ('r', 'p')
                and c.relname not in (select table_name from private.erp_reset_tables())
                and c.relname not in (select table_name from private.erp_reset_kept_tables())),
  (select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')
     and c.relname not in (select table_name from private.erp_reset_tables())
     and c.relname not in (select table_name from private.erp_reset_kept_tables())));
select rls_test.ok('catalogue: no table is both resettable and kept',
  not exists (select 1 from private.erp_reset_tables() t join private.erp_reset_kept_tables() k using (table_name)));
select rls_test.ok('catalogue: every listed table exists',
  not exists (select 1 from (select table_name from private.erp_reset_tables() union all select table_name from private.erp_reset_kept_tables()) x
              where to_regclass('public.' || x.table_name) is null));
-- V2 Stage 2 adds parties and supplier_payments; the product / purchase
-- enhancements add purchase_document_refs, the stock reliability migration production_order_requests (79 tables).
-- The form drafts migration adds erp_form_drafts (80 tables).
select rls_test.ok('catalogue: allowlist has 80 tables, no duplicates',
  (select count(*) from private.erp_reset_tables()) = 80 and (select count(distinct table_name) from private.erp_reset_tables()) = 80);
select rls_test.ok('catalogue: every resettable table is company-scoped (company_id)',
  not exists (select 1 from private.erp_reset_tables() t where not exists (
    select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = t.table_name and c.column_name = 'company_id')));
select rls_test.ok('catalogue: kept tables marked company-scoped have company_id',
  not exists (select 1 from private.erp_reset_kept_tables() k where k.company_scoped and k.table_name <> 'companies' and not exists (
    select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = k.table_name and c.column_name = 'company_id')));
select rls_test.ok('catalogue: core business tables are resettable',
  (select count(*) from private.erp_reset_tables() where table_name in ('sales_orders', 'sales_order_lines', 'purchase_orders', 'purchase_order_lines',
     'sales_invoices', 'sales_invoice_lines', 'customer_payments', 'invoice_payment_allocations', 'customers', 'suppliers', 'customer_purchase_orders',
     'production_orders', 'production_material_consumption', 'production_output_receipts', 'boms', 'bom_items', 'goods_receipts', 'goods_receipt_lines',
     'fulfilments', 'stock_reservations', 'inventory_balances', 'inventory_batches', 'inventory_counts', 'inventory_adjustments', 'inventory_requests',
     'outsourcing_orders', 'notifications', 'import_jobs', 'amazon_listings', 'amazon_sku_daily', 'amazon_recommendations')) = 31);
select rls_test.ok('catalogue: identity, access control, audit and configuration are kept',
  (select count(*) from private.erp_reset_kept_tables() where table_name in ('companies', 'company_settings', 'profiles', 'user_roles', 'roles',
     'permissions', 'role_permissions', 'audit_logs', 'invoice_settings', 'approval_workflows', 'warehouses', 'inventory_locations')) = 12);

-- Deletion order: every foreign key between resettable tables points from a
-- table deleted earlier (lower ord) to one deleted later.
select rls_test.ok('order: every foreign key child is deleted before its parent',
  not exists (
    select 1 from pg_constraint con
    join pg_class ch on ch.oid = con.conrelid join pg_class pa on pa.oid = con.confrelid
    join private.erp_reset_tables() tc on tc.table_name = ch.relname
    join private.erp_reset_tables() tp on tp.table_name = pa.relname
    where con.contype = 'f' and ch.oid <> pa.oid and tc.ord >= tp.ord),
  (select string_agg(ch.relname || '->' || pa.relname, ', ') from pg_constraint con
    join pg_class ch on ch.oid = con.conrelid join pg_class pa on pa.oid = con.confrelid
    join private.erp_reset_tables() tc on tc.table_name = ch.relname
    join private.erp_reset_tables() tp on tp.table_name = pa.relname
    where con.contype = 'f' and ch.oid <> pa.oid and tc.ord >= tp.ord));
select rls_test.ok('order: the only kept table referencing a resettable one is products -> suppliers (kept suppliers stay)',
  (select string_agg(ch.relname || '->' || pa.relname, ',') from pg_constraint con
    join pg_class ch on ch.oid = con.conrelid join pg_class pa on pa.oid = con.confrelid
    join pg_namespace n on n.oid = ch.relnamespace
    where con.contype = 'f' and n.nspname = 'public'
      and ch.relname in (select table_name from private.erp_reset_kept_tables())
      and pa.relname in (select table_name from private.erp_reset_tables())) = 'products->suppliers');
select rls_test.ok('order: no cascading delete reaches a kept table',
  not exists (select 1 from pg_constraint con join pg_class ch on ch.oid = con.conrelid join pg_class pa on pa.oid = con.confrelid
              where con.contype = 'f' and con.confdeltype in ('c', 'n', 'd')
                and ch.relname in (select table_name from private.erp_reset_kept_tables())
                and pa.relname in (select table_name from private.erp_reset_tables())));
select rls_test.ok('guards: append-only and never-delete tables are detected from the catalogue',
  (select count(*) from private.erp_reset_guarded_tables() where table_name in ('inventory_transactions', 'boms', 'sales_invoices', 'customer_payments',
     'invoice_adjustment_notes', 'sales_order_events', 'import_jobs', 'approval_decisions', 'goods_receipt_lines', 'production_material_consumption')) = 10,
  (select string_agg(table_name || ':' || guard_function, ', ') from private.erp_reset_guarded_tables()));
select rls_test.ok('guards: reasons are explained for every detected guard',
  not exists (select 1 from private.erp_reset_guarded_tables() g where private.erp_reset_guard_reason(g.guard_function) like 'Protected by%'),
  (select string_agg(guard_function, ', ') from private.erp_reset_guarded_tables() g where private.erp_reset_guard_reason(g.guard_function) like 'Protected by%'));

-- ---------------------------------------------------------------------------
-- 2. Permissions and callers
-- ---------------------------------------------------------------------------
select rls_test.ok('permission: system.reset_data exists and only SUPER_ADMIN holds it',
  (select string_agg(r.code, ',') from public.role_permissions rp join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id where p.code = 'system.reset_data') = 'SUPER_ADMIN');
select rls_test.ok('grants: execute / verify / attempt functions are service_role only',
  not has_function_privilege('authenticated', 'public.erp_reset_execute(uuid, uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.erp_reset_execute(uuid, uuid, text)', 'execute')
  and has_function_privilege('service_role', 'public.erp_reset_execute(uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.erp_reset_verify(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.erp_reset_record_attempt(uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.erp_reset_attempt_allowed(uuid)', 'execute'));
select rls_test.ok('grants: preview is for signed-in users only',
  has_function_privilege('authenticated', 'public.erp_reset_preview()', 'execute')
  and not has_function_privilege('anon', 'public.erp_reset_preview()', 'execute'));
select rls_test.ok('grants: private helpers are not callable by API roles',
  not has_function_privilege('authenticated', 'private.erp_reset_plan(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.erp_reset_counts(uuid)', 'execute'));
select rls_test.ok('history: erp_reset_runs has RLS and no client write grants',
  (select relrowsecurity from pg_class where oid = 'public.erp_reset_runs'::regclass)
  and not has_table_privilege('authenticated', 'public.erp_reset_runs', 'insert')
  and not has_table_privilege('authenticated', 'public.erp_reset_runs', 'update')
  and not has_table_privilege('authenticated', 'public.erp_reset_runs', 'delete')
  and not has_table_privilege('anon', 'public.erp_reset_runs', 'select'));

set local role authenticated;
select rls_test.claims('b_sa');
select rls_test.expect_call_error('callers: a signed-in Super Admin cannot call erp_reset_execute directly (browser bypass)',
  format($q$ select public.erp_reset_execute(%L, gen_random_uuid(), 'RESET ERP') $q$, rls_test.id('b_sa')), 'permission denied');
select rls_test.expect_call_error('callers: nor erp_reset_verify', format($q$ select public.erp_reset_verify(%L) $q$, rls_test.id('b_sa')), 'permission denied');
select rls_test.claims('b_adm');
select rls_test.expect_call_error('preview: an Admin (not Super Admin) is refused', $q$ select public.erp_reset_preview() $q$, 'Super Admin');
select rls_test.claims('b_im');
select rls_test.expect_call_error('preview: an Inventory Manager is refused', $q$ select public.erp_reset_preview() $q$, 'Super Admin');
reset role;
set local role anon;
select set_config('request.jwt.claims', '', true);
select rls_test.expect_call_error('preview: anonymous callers are refused', $q$ select public.erp_reset_preview() $q$, 'permission denied');
reset role;

-- ---------------------------------------------------------------------------
-- 3. Preview
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('b_sa');
select rls_test.expect_call_ok('preview: Super Admin B gets the impact report', 'prev_b', $q$ select public.erp_reset_preview() $q$);
select rls_test.ok('preview: company B can be reset (no protected records)', (rls_test.get('prev_b') ->> 'can_reset')::boolean, rls_test.get('prev_b') ->> 'blockers');
-- V2: each customer and supplier has a ledger party (4 more rows: 2 customers, 2 suppliers incl. the kept one, recreated by ledger_sync_parties).
select rls_test.ok('preview: delete total counts the fixtures (2 customers, code, supplier, 2 CPO revisions, notification, alert, sync job, sync error, request, 4 ledger parties)',
  (rls_test.get('prev_b') ->> 'delete_total')::int = 15, rls_test.get('prev_b') ->> 'delete_total');
select rls_test.ok('preview: one supplier is kept because a product names it',
  (rls_test.get('prev_b') ->> 'kept_suppliers')::int = 1);
select rls_test.ok('preview: lists what is kept (profiles 4, products 2, documents 1)',
  (select (e ->> 'rows')::int from jsonb_array_elements(rls_test.get('prev_b') -> 'keep') e where e ->> 'table' = 'profiles') = 4
  and (select (e ->> 'rows')::int from jsonb_array_elements(rls_test.get('prev_b') -> 'keep') e where e ->> 'table' = 'products') = 2
  and (select (e ->> 'rows')::int from jsonb_array_elements(rls_test.get('prev_b') -> 'keep') e where e ->> 'table' = 'documents') = 1);
select rls_test.ok('preview: raw internal counts are not exposed', not (rls_test.get('prev_b') ? 'counts'));
select rls_test.claims('a_sa');
select rls_test.expect_call_ok('preview: Super Admin A gets the impact report', 'prev_a', $q$ select public.erp_reset_preview() $q$);
select rls_test.ok('preview: company A is blocked by protected import history',
  not (rls_test.get('prev_a') ->> 'can_reset')::boolean
  and exists (select 1 from jsonb_array_elements(rls_test.get('prev_a') -> 'blockers') b
              where b ->> 'table' = 'customer_po_import_batches' and b ->> 'kind' = 'PROTECTED_RECORDS' and (b ->> 'rows')::int = 1),
  rls_test.get('prev_a') ->> 'blockers');
select rls_test.ok('preview: the import batch also wrote append-only import history, listed as a blocker',
  exists (select 1 from jsonb_array_elements(rls_test.get('prev_a') -> 'blockers') b where b ->> 'table' = 'import_jobs'),
  rls_test.get('prev_a') ->> 'blockers');
select rls_test.ok('preview: company isolation (A sees only its own customer)',
  (select (e ->> 'rows')::int from jsonb_array_elements(rls_test.get('prev_a') -> 'delete') e where e ->> 'table' = 'customers') = 1);
select rls_test.claims('c_sa');
select rls_test.expect_call_ok('preview: Super Admin C gets the impact report', 'prev_c', $q$ select public.erp_reset_preview() $q$);
select rls_test.ok('preview: a document attached to a customer blocks the reset',
  exists (select 1 from jsonb_array_elements(rls_test.get('prev_c') -> 'blockers') b where b ->> 'kind' = 'ATTACHED_DOCUMENTS' and (b ->> 'rows')::int = 1),
  rls_test.get('prev_c') ->> 'blockers');
reset role;

-- ---------------------------------------------------------------------------
-- 4. Execute: input, authorization, blocked
-- ---------------------------------------------------------------------------
set local role service_role;
select rls_test.expect_call_error('execute: wrong confirmation text is refused',
  format($q$ select public.erp_reset_execute(%L, %L, 'reset erp') $q$, rls_test.id('b_sa'), rls_test.id('req_b')), 'RESET ERP');
select rls_test.expect_call_ok('execute: an Admin (not Super Admin) is denied', 'denied',
  format($q$ select public.erp_reset_execute(%L, gen_random_uuid(), 'RESET ERP') $q$, rls_test.id('b_adm')));
reset role;
select rls_test.ok('execute: denied attempt returns DENIED, deletes nothing and is audited',
  rls_test.get('denied') ->> 'status' = 'DENIED' and rls_test.n('customers', rls_test.id('company_b')) = 2
  and rls_test.audits(rls_test.id('company_b'), 'erp_reset.denied') = 1, rls_test.get('denied')::text);

select rls_test.set('a_rows_before', rls_test.company_rows(rls_test.id('company_a')));
set local role service_role;
select rls_test.expect_call_ok('execute: company A runs', 'run_a',
  format($q$ select public.erp_reset_execute(%L, %L, 'RESET ERP') $q$, rls_test.id('a_sa'), rls_test.id('req_a')));
reset role;
select rls_test.ok('blocked: status BLOCKED with the blockers listed',
  rls_test.get('run_a') ->> 'status' = 'BLOCKED' and jsonb_array_length(rls_test.get('run_a') -> 'blockers') >= 1
  and (rls_test.get('run_a') ->> 'deleted_total')::int = 0, rls_test.get('run_a')::text);
select rls_test.ok('blocked: nothing at all was deleted in company A',
  rls_test.company_rows(rls_test.id('company_a')) - 'audit_logs' - 'erp_reset_runs' = rls_test.get('a_rows_before') - 'audit_logs' - 'erp_reset_runs');
select rls_test.ok('blocked: attempt recorded in erp_reset_runs and audit_logs',
  exists (select 1 from public.erp_reset_runs where company_id = rls_test.id('company_a') and request_id = rls_test.id('req_a') and status = 'BLOCKED')
  and rls_test.audits(rls_test.id('company_a'), 'erp_reset.blocked') = 1);

-- ---------------------------------------------------------------------------
-- 5. Execute: completed reset of company B
-- ---------------------------------------------------------------------------
select rls_test.set('fp_before', rls_test.fingerprint());
select rls_test.set('a_rows_mid', rls_test.company_rows(rls_test.id('company_a')));
select rls_test.set('c_rows_mid', rls_test.company_rows(rls_test.id('company_c')));
select rls_test.set('global_before', jsonb_build_object(
  'roles', (select count(*) from public.roles), 'permissions', (select count(*) from public.permissions),
  'role_permissions', (select count(*) from public.role_permissions), 'auth_users', (select count(*) from auth.users),
  'audit_logs_b', rls_test.n('audit_logs', rls_test.id('company_b'))));
select rls_test.set('b_settings_before', (select jsonb_agg(to_jsonb(s) order by s.setting_key) from public.company_settings s where s.company_id = rls_test.id('company_b')));

set local role service_role;
select rls_test.expect_call_ok('execute: company B runs', 'run_b',
  format($q$ select public.erp_reset_execute(%L, %L, 'RESET ERP') $q$, rls_test.id('b_sa'), rls_test.id('req_b')));
reset role;
select rls_test.ok('completed: status COMPLETED with 15 records deleted (11 + 4 ledger parties)',
  rls_test.get('run_b') ->> 'status' = 'COMPLETED' and (rls_test.get('run_b') ->> 'deleted_total')::int = 15 and (rls_test.get('run_b') -> 'deleted' ->> 'parties')::int = 4, rls_test.get('run_b')::text);
select rls_test.ok('completed: per-table counts returned (customers 2, customer POs 2, suppliers 1)',
  (rls_test.get('run_b') -> 'deleted' ->> 'customers')::int = 2 and (rls_test.get('run_b') -> 'deleted' ->> 'customer_purchase_orders')::int = 2
  and (rls_test.get('run_b') -> 'deleted' ->> 'suppliers')::int = 1);
select rls_test.ok('completed: in-transaction verification passed',
  (rls_test.get('run_b') -> 'verification' ->> 'allowlist_empty')::boolean and (rls_test.get('run_b') -> 'verification' ->> 'schema_unchanged')::boolean
  and (rls_test.get('run_b') -> 'verification' ->> 'actor_access_valid')::boolean);
select rls_test.ok('completed: business rows are gone from the tables',
  rls_test.n('customers', rls_test.id('company_b')) = 0 and rls_test.n('customer_product_codes', rls_test.id('company_b')) = 0
  and rls_test.n('customer_purchase_orders', rls_test.id('company_b')) = 0 and rls_test.n('notifications', rls_test.id('company_b')) = 0
  and rls_test.n('inventory_alerts', rls_test.id('company_b')) = 0 and rls_test.n('amazon_sync_jobs', rls_test.id('company_b')) = 0
  and rls_test.n('amazon_sync_errors', rls_test.id('company_b')) = 0 and rls_test.n('inventory_requests', rls_test.id('company_b')) = 0);
select rls_test.ok('completed: every resettable table of company B is empty (except the kept supplier)',
  not exists (select 1 from private.erp_reset_tables() t
              where rls_test.n(t.table_name, rls_test.id('company_b')) <> case when t.table_name = 'suppliers' then 1 else 0 end));
select rls_test.ok('completed: supplier named by a product is kept, the other deleted',
  exists (select 1 from public.suppliers where id = rls_test.id('b_sup_keep'))
  and not exists (select 1 from public.suppliers where id = rls_test.id('b_sup_del'))
  and (select preferred_supplier_id from public.products where id = rls_test.id('b_prod')) = rls_test.id('b_sup_keep'));
select rls_test.ok('completed: products, document and company settings unchanged',
  rls_test.n('products', rls_test.id('company_b')) = 2 and rls_test.n('documents', rls_test.id('company_b')) = 1
  and (select jsonb_agg(to_jsonb(s) order by s.setting_key) from public.company_settings s where s.company_id = rls_test.id('company_b')) = rls_test.get('b_settings_before'));
select rls_test.ok('completed: initiating Super Admin keeps profile, company, role and permission',
  exists (select 1 from public.profiles where id = rls_test.id('b_sa') and is_active and company_id = rls_test.id('company_b'))
  and private.erp_reset_actor_ok(rls_test.id('b_sa'), rls_test.id('company_b'))
  and exists (select 1 from auth.users where id = rls_test.id('b_sa')));
select rls_test.ok('completed: other Super Admin and other users preserved',
  private.user_has_role(rls_test.id('b_sa2'), rls_test.id('company_b'), 'SUPER_ADMIN')
  and rls_test.n('profiles', rls_test.id('company_b')) = 4 and rls_test.n('user_roles', rls_test.id('company_b')) = 4);
select rls_test.ok('completed: roles, permissions, grants and auth users unchanged',
  (select count(*) from public.roles) = (rls_test.get('global_before') ->> 'roles')::int
  and (select count(*) from public.permissions) = (rls_test.get('global_before') ->> 'permissions')::int
  and (select count(*) from public.role_permissions) = (rls_test.get('global_before') ->> 'role_permissions')::int
  and (select count(*) from auth.users) = (rls_test.get('global_before') ->> 'auth_users')::int);
select rls_test.ok('completed: other companies untouched (isolation)',
  rls_test.company_rows(rls_test.id('company_a')) = rls_test.get('a_rows_mid')
  and rls_test.company_rows(rls_test.id('company_c')) = rls_test.get('c_rows_mid'));
select rls_test.ok('completed: schema objects (tables, RLS, policies, triggers, constraints, indexes, functions) unchanged',
  rls_test.fingerprint() = rls_test.get('fp_before'), rls_test.fingerprint()::text || ' vs ' || rls_test.get('fp_before')::text);
select rls_test.ok('completed: RLS still enabled on every public table and no trigger disabled',
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity)
  and not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and not t.tgisinternal and t.tgenabled = 'D'));
select rls_test.ok('completed: existing audit history kept, one completion event appended with the actor',
  rls_test.n('audit_logs', rls_test.id('company_b')) = (rls_test.get('global_before') ->> 'audit_logs_b')::int + 1
  and exists (select 1 from public.audit_logs where company_id = rls_test.id('company_b') and action = 'erp_reset.completed'
              and actor_user_id = rls_test.id('b_sa') and resource_id = rls_test.get('run_b') ->> 'run_id'
              and (metadata ->> 'deleted_total')::int = 15));
select rls_test.ok('completed: audit record and run contain no secrets',
  not exists (select 1 from public.audit_logs where company_id = rls_test.id('company_b') and action like 'erp_reset.%'
              and metadata::text ~* '(password|token|secret)')
  and not exists (select 1 from public.erp_reset_runs where company_id = rls_test.id('company_b') and to_jsonb(erp_reset_runs)::text ~* '(password|token|secret)'));

set local role service_role;
select rls_test.expect_call_ok('verify: post-commit verification', 'verify_b', format($q$ select public.erp_reset_verify(%L) $q$, rls_test.id('b_sa')));
-- Replay of the same request: stored result, no second run.
select rls_test.expect_call_ok('idempotency: the same request id again', 'replay_b',
  format($q$ select public.erp_reset_execute(%L, %L, 'RESET ERP') $q$, rls_test.id('b_sa'), rls_test.id('req_b')));
reset role;
select rls_test.ok('verify: ok, Super Admin access valid, nothing remaining',
  (rls_test.get('verify_b') ->> 'ok')::boolean and (rls_test.get('verify_b') ->> 'actor_access_valid')::boolean
  and rls_test.get('verify_b') -> 'remaining' = '{}'::jsonb and (rls_test.get('verify_b') ->> 'super_admins')::int = 2, rls_test.get('verify_b')::text);
select rls_test.ok('idempotency: replay returns the stored result and runs nothing',
  (rls_test.get('replay_b') ->> 'replayed')::boolean and rls_test.get('replay_b') ->> 'run_id' = rls_test.get('run_b') ->> 'run_id'
  and (select count(*) from public.erp_reset_runs where company_id = rls_test.id('company_b')) = 1
  and rls_test.audits(rls_test.id('company_b'), 'erp_reset.completed') = 1);

-- RLS on the run history.
set local role authenticated;
select rls_test.claims('b_sa');
select rls_test.ok('history: Super Admin B sees B''s run', (select count(*) from public.erp_reset_runs) = 1);
select rls_test.expect_call_error('history: runs cannot be inserted by clients',
  format($q$ insert into public.erp_reset_runs (company_id, request_id, requested_by, status) values (%L, gen_random_uuid(), %L, 'COMPLETED') returning '{}'::jsonb $q$,
    rls_test.id('company_b'), rls_test.id('b_sa')), 'permission denied');
select rls_test.claims('b_adm');
select rls_test.ok('history: an Admin without system.reset_data sees no runs', (select count(*) from public.erp_reset_runs) = 0);
select rls_test.claims('a_sa');
select rls_test.ok('history: Super Admin A sees only A''s run', (select count(*) from public.erp_reset_runs) = 1
  and (select company_id from public.erp_reset_runs limit 1) = rls_test.id('company_a'));
reset role;
select rls_test.expect_call_error('history: runs are append-only (update refused, even for the owner)',
  format($q$ update public.erp_reset_runs set status = 'FAILED' where company_id = %L returning '{}'::jsonb $q$, rls_test.id('company_b')), 'cannot be changed');

-- ---------------------------------------------------------------------------
-- 6. Failure is rolled back and reported
-- ---------------------------------------------------------------------------
insert into public.customers (id, company_id, customer_code, customer_name) values (rls_test.id('b_cust3'), rls_test.id('company_b'), 'ERB-C3', 'New customer of B');
insert into public.notifications (company_id, recipient_user_id, notification_type, title, message)
values (rls_test.id('company_b'), rls_test.id('b_im'), 'LOW_STOCK', 'Low stock', 'again');
create function rls_test.fail_delete() returns trigger language plpgsql as $$ begin raise exception 'simulated storage failure'; end $$;
create trigger zz_test_fail_delete after delete on public.customers for each row execute function rls_test.fail_delete();
set local role service_role;
select rls_test.expect_call_ok('failure: reset with a failing deletion', 'run_fail',
  format($q$ select public.erp_reset_execute(%L, %L, 'RESET ERP') $q$, rls_test.id('b_sa'), rls_test.id('req_b2')));
reset role;
drop trigger zz_test_fail_delete on public.customers;
select rls_test.ok('failure: status FAILED with the real reason, no success claimed',
  rls_test.get('run_fail') ->> 'status' = 'FAILED' and rls_test.get('run_fail') ->> 'error' ilike '%customers%simulated storage failure%'
  and (rls_test.get('run_fail') ->> 'deleted_total')::int = 0, rls_test.get('run_fail')::text);
select rls_test.ok('failure: every deletion of the attempt was rolled back (notification deleted earlier in the order is back)',
  rls_test.n('customers', rls_test.id('company_b')) = 1 and rls_test.n('notifications', rls_test.id('company_b')) = 1);
select rls_test.ok('failure: recorded as FAILED in history and audit',
  exists (select 1 from public.erp_reset_runs where request_id = rls_test.id('req_b2') and status = 'FAILED')
  and rls_test.audits(rls_test.id('company_b'), 'erp_reset.failed') = 1);

-- ---------------------------------------------------------------------------
-- 7. A table added later without classification blocks the reset
-- ---------------------------------------------------------------------------
create table public.zz_unclassified_test (id uuid primary key default gen_random_uuid(), company_id uuid);
alter table public.zz_unclassified_test enable row level security;
set local role service_role;
select rls_test.expect_call_ok('unclassified: reset with an unreviewed table', 'run_uncl',
  format($q$ select public.erp_reset_execute(%L, %L, 'RESET ERP') $q$, rls_test.id('b_sa'), rls_test.id('req_b3')));
reset role;
drop table public.zz_unclassified_test;
select rls_test.ok('unclassified: BLOCKED naming the table, nothing deleted',
  rls_test.get('run_uncl') ->> 'status' = 'BLOCKED'
  and exists (select 1 from jsonb_array_elements(rls_test.get('run_uncl') -> 'blockers') b where b ->> 'kind' = 'UNCLASSIFIED_TABLE' and b ->> 'table' = 'zz_unclassified_test')
  and rls_test.n('customers', rls_test.id('company_b')) = 1, rls_test.get('run_uncl')::text);

-- The second reset (after the failure) succeeds.
set local role service_role;
select rls_test.expect_call_ok('retry: a new request after fixing the problem', 'run_b4',
  format($q$ select public.erp_reset_execute(%L, %L, 'RESET ERP') $q$, rls_test.id('b_sa'), rls_test.id('req_b4')));
reset role;
select rls_test.ok('retry: COMPLETED, the new customer (with its ledger party) and notification deleted',
  rls_test.get('run_b4') ->> 'status' = 'COMPLETED' and (rls_test.get('run_b4') ->> 'deleted_total')::int = 3
  and rls_test.n('customers', rls_test.id('company_b')) = 0, rls_test.get('run_b4')::text);

-- ---------------------------------------------------------------------------
-- 8. Document blocker (company C) and password-attempt limit
-- ---------------------------------------------------------------------------
set local role service_role;
select rls_test.expect_call_ok('documents: company C runs', 'run_c',
  format($q$ select public.erp_reset_execute(%L, %L, 'RESET ERP') $q$, rls_test.id('c_sa'), rls_test.id('req_c')));
reset role;
select rls_test.ok('documents: BLOCKED, the customer and its document kept',
  rls_test.get('run_c') ->> 'status' = 'BLOCKED' and rls_test.n('customers', rls_test.id('company_c')) = 1 and rls_test.n('documents', rls_test.id('company_c')) = 1);

set local role service_role;
select rls_test.expect_call_ok('attempts: first check allowed', 'att0', format($q$ select public.erp_reset_attempt_allowed(%L) $q$, rls_test.id('c_sa')));
select public.erp_reset_record_attempt(rls_test.id('c_sa'), 'REAUTH_FAILED') from generate_series(1, 5);
select rls_test.expect_call_ok('attempts: after five wrong passwords', 'att5', format($q$ select public.erp_reset_attempt_allowed(%L) $q$, rls_test.id('c_sa')));
select rls_test.expect_call_ok('attempts: another user is not affected', 'att_other', format($q$ select public.erp_reset_attempt_allowed(%L) $q$, rls_test.id('b_sa')));
select rls_test.expect_call_error('attempts: only known outcomes are recorded',
  format($q$ select public.erp_reset_record_attempt(%L, 'PASSWORD=hunter2') $q$, rls_test.id('c_sa')), 'Unknown outcome');
reset role;
select rls_test.ok('attempts: allowed before, locked after 5 failures in 15 minutes, per user',
  (rls_test.get('att0') ->> 'allowed')::boolean and not (rls_test.get('att5') ->> 'allowed')::boolean
  and (rls_test.get('att_other') ->> 'allowed')::boolean);
select rls_test.ok('attempts: failures are audited without the password',
  rls_test.audits(rls_test.id('company_c'), 'erp_reset.reauth_failed') = 5
  and not exists (select 1 from public.audit_logs where action like 'erp_reset.%' and metadata::text ilike '%hunter2%'));

-- ===========================================================================
-- Result
-- ===========================================================================
do $$
declare
  v_passed int;
  v_failed int;
  v_report text;
begin
  select count(*) filter (where passed), count(*) filter (where not passed) into v_passed, v_failed from rls_test.results;
  select string_agg(format('%s %s%s', case when passed then 'PASS' else 'FAIL' end, name,
                           case when passed then '' else ' -- ' || coalesce(detail, '') end), E'\n' order by id)
    into v_report from rls_test.results;
  raise exception 'ERP_RESET_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
