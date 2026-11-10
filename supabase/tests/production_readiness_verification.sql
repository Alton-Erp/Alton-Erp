-- =============================================================================
-- PRODUCTION READINESS (PHASE 11) VERIFICATION
--
-- 1. Catalog-wide security checks (RLS coverage, anonymous access, privileged
--    function search paths, views, storage buckets, append-only records).
-- 2. The end-to-end business scenario through the real database functions:
--    product -> warehouse -> opening stock -> BOM -> production (reserve, issue,
--    output) -> customer PO import and matching -> sales order -> allocation ->
--    pick/pack/dispatch -> ledger -> invoice (GST) -> partial and final payment
--    -> receivables -> executive dashboard reconciliation -> audit trail.
-- 3. Stock ledger and reservation invariants (balances = posted movements,
--    reserved = open reservations) for every company in the database.
-- 4. Generic cross-company isolation over EVERY company-scoped table and view
--    (read and write), plus function-level cross-company attempts.
-- 5. Privilege escalation and workflow-bypass attempts.
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (staging only)
--
-- Runs in one transaction with its own companies (RDA / RDB) and ALWAYS ends by
-- raising READINESS_VERIFICATION_RESULT passed=N failed=M (rolls everything back).
-- =============================================================================

begin;

create schema rls_test;
grant usage on schema rls_test to anon, authenticated;
create table rls_test.results (id serial primary key, name text not null, passed boolean not null, detail text);
create table rls_test.ids (key text primary key, id uuid not null);
create table rls_test.vars (key text primary key, value jsonb);
grant select, insert on rls_test.results to anon, authenticated;
grant usage on sequence rls_test.results_id_seq to anon, authenticated;
grant select on rls_test.ids to anon, authenticated;
grant select, insert, update on rls_test.vars to anon, authenticated;

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
create function rls_test.gid(p_key text, p_field text) returns uuid language sql stable as $$ select (value ->> p_field)::uuid from rls_test.vars where key = p_key $$;
create function rls_test.expect_call_ok(p_name text, p_key text, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.set(p_key, r); perform rls_test.ok(p_name, not (r ? 'error'), left(r::text, 1500)); return r; end $$;
create function rls_test.expect_call_error(p_name text, p_sql text, p_pattern text default null) returns void language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.ok(p_name, r ? 'error' and (p_pattern is null or r ->> 'error' ilike '%' || p_pattern || '%'), left(r::text, 500)); end $$;
-- A write is "blocked" when it raises an error or affects no row.
create function rls_test.expect_blocked(p_name text, p_sql text) returns void language plpgsql as $$
declare n bigint;
begin
  execute p_sql; get diagnostics n = row_count;
  perform rls_test.ok(p_name, n = 0, format('statement affected %s row(s)', n));
exception when others then perform rls_test.ok(p_name, true, format('rejected %s: %s', sqlstate, left(sqlerrm, 200))); end $$;
create function rls_test.claims(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', rls_test.id(p_key), 'role', 'authenticated')::text, true) $$;
create function rls_test.today() returns date language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;
create function rls_test.pick(p_arr jsonb, p_key text, p_value text, p_field text) returns numeric language sql immutable as $$
  select (e ->> p_field)::numeric from jsonb_array_elements(coalesce(p_arr, '[]'::jsonb)) e where e ->> p_key = p_value limit 1 $$;
create function rls_test.n(p_key text, p_path text[]) returns numeric language sql stable as $$ select (rls_test.get(p_key) #>> p_path)::numeric $$;

-- Owner-side probes (read the truth regardless of RLS)
create function rls_test.on_hand(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(on_hand), 0) from public.inventory_balances where product_id = p_product $$;
create function rls_test.reserved(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(reserved), 0) from public.inventory_balances where product_id = p_product $$;
create function rls_test.lot(p_product uuid) returns uuid language sql stable security definer as $$
  select id from public.inventory_batches where product_id = p_product order by created_at limit 1 $$;
create function rls_test.material(p_order uuid, p_product uuid) returns uuid language sql stable security definer as $$
  select id from public.production_order_materials where production_order_id = p_order and component_product_id = p_product $$;
create function rls_test.fl(p_ful uuid, p_product uuid) returns uuid language sql stable security definer as $$
  select id from public.fulfilment_lines where fulfilment_id = p_ful and product_id = p_product $$;
create function rls_test.po_line(p_po uuid, p_no int) returns uuid language sql stable security definer as $$
  select id from public.customer_purchase_order_lines where purchase_order_id = p_po and line_no = p_no $$;
create function rls_test.inv_bal(p_inv uuid) returns numeric language sql stable security definer as $$ select private.invoice_balance(p_inv) $$;
create function rls_test.tx_count(p_company uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.inventory_transactions where company_id = p_company $$;
-- Ledger invariant: every balance equals the sum of its posted movements (and no movements without a balance).
create function rls_test.ledger_mismatches(p_company uuid default null) returns text language sql stable security definer as $$
  with tx as (select company_id, batch_id, location_id, sum(direction * quantity) q from public.inventory_transactions
              where p_company is null or company_id = p_company group by 1, 2, 3),
       bal as (select company_id, batch_id, location_id, on_hand q from public.inventory_balances where p_company is null or company_id = p_company)
  select string_agg(format('%s@%s ledger=%s balance=%s', coalesce(tx.batch_id, bal.batch_id), coalesce(tx.location_id, bal.location_id), coalesce(tx.q, 0), coalesce(bal.q, 0)), '; ')
  from tx full join bal on bal.batch_id = tx.batch_id and bal.location_id = tx.location_id
  where coalesce(tx.q, 0) <> coalesce(bal.q, 0) $$;
-- Reservation invariant: balance.reserved equals the open remainder of its reservations.
create function rls_test.reservation_mismatches(p_company uuid default null) returns text language sql stable security definer as $$
  with r as (select batch_id, location_id, sum(quantity - fulfilled_quantity - released_quantity) q from public.stock_reservations
             where reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') and (p_company is null or company_id = p_company) group by 1, 2)
  select string_agg(format('%s@%s reservations=%s balance.reserved=%s', b.batch_id, b.location_id, coalesce(r.q, 0), b.reserved), '; ')
  from public.inventory_balances b left join r on r.batch_id = b.batch_id and r.location_id = b.location_id
  where (p_company is null or b.company_id = p_company) and b.reserved <> coalesce(r.q, 0) $$;
-- Rows of another company visible to the CURRENT (authenticated) user across every company-scoped relation.
create function rls_test.foreign_rows_visible(p_other uuid) returns jsonb language plpgsql as $$
declare rel record; n bigint; checked int := 0; leaks text[] := '{}';
begin
  for rel in select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
             where s.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
               and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped)
               and has_table_privilege(c.oid, 'SELECT') loop
    begin
      execute format('select count(*) from public.%I where company_id = $1', rel.relname) into n using p_other;
      checked := checked + 1;
      if n > 0 then leaks := leaks || format('%s=%s', rel.relname, n); end if;
    exception when insufficient_privilege then checked := checked + 1;  -- column not readable: nothing visible
    end;
  end loop;
  return jsonb_build_object('checked', checked, 'leaks', to_jsonb(leaks));
end $$;
-- Rows of another company the CURRENT user can change (no-op update of the first updatable column).
create function rls_test.foreign_rows_writable(p_other uuid) returns jsonb language plpgsql as $$
declare rel record; n bigint; checked int := 0; leaks text[] := '{}';
begin
  for rel in select c.relname, (select a.attname from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                                  and has_column_privilege(c.oid, a.attnum, 'UPDATE') order by a.attnum limit 1) col
             from pg_class c join pg_namespace s on s.oid = c.relnamespace
             where s.nspname = 'public' and c.relkind = 'r'
               and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped) loop
    continue when rel.col is null;
    checked := checked + 1;
    begin
      execute format('update public.%I set %I = %I where company_id = $1', rel.relname, rel.col, rel.col) using p_other;
      get diagnostics n = row_count;
      if n > 0 then leaks := leaks || format('%s=%s', rel.relname, n); end if;
    exception when others then null;  -- rejected
    end;
  end loop;
  return jsonb_build_object('checked', checked, 'leaks', to_jsonb(leaks));
end $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ===========================================================================
-- 1. CATALOG-WIDE SECURITY
-- ===========================================================================
select rls_test.ok('catalog: every public table has row-level security enabled',
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  (select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity));
select rls_test.ok('catalog: no policy is granted to anon/public or is unconditional (using true)',
  not exists (select 1 from pg_policies where schemaname in ('public', 'storage') and (roles::text ~ '(anon|public)' or qual = 'true' or with_check = 'true')));
select rls_test.ok('catalog: anonymous users have no privilege on any public table or view',
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
              where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p') and has_table_privilege('anon', c.oid, p)));
select rls_test.ok('catalog: anonymous users cannot execute any public function',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'EXECUTE')),
  (select string_agg(p.oid::regprocedure::text, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'EXECUTE')));
select rls_test.ok('catalog: every SECURITY DEFINER function pins an empty search_path',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.prosecdef
              and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c in ('search_path=""', 'search_path='))));
select rls_test.ok('catalog: every public SECURITY DEFINER function callable by users checks permission or identity',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.prosecdef and p.prokind = 'f' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
                and p.prosrc !~* '(require_permission|require_any_permission|has_permission|auth\.uid|current_company_id|get_my_access|has_role|is_active_member)'),
  (select string_agg(p.proname, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef and p.prokind = 'f' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and p.prosrc !~* '(require_permission|require_any_permission|has_permission|auth\.uid|current_company_id|get_my_access|has_role|is_active_member)'));
select rls_test.ok('catalog: every public view runs with the caller''s rights (security_invoker), so RLS applies',
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('v', 'm')
              and not coalesce(c.reloptions::text[] && array['security_invoker=true', 'security_invoker=on'], false)));
select rls_test.ok('catalog: every storage bucket is private', not exists (select 1 from storage.buckets where coalesce(public, false)));
select rls_test.ok('catalog: append-only protection exists on the audit log, stock ledger, approval decisions and import history',
  (select count(distinct event_object_table) from information_schema.triggers where trigger_name in ('audit_logs_append_only', 'inventory_transactions_append_only',
     'approval_decisions_append_only') and event_manipulation in ('UPDATE', 'DELETE')) = 3
  and exists (select 1 from information_schema.triggers where event_object_table = 'import_jobs' and event_manipulation in ('UPDATE', 'DELETE')));
select rls_test.ok('catalog: signed-in users have no direct write access to the stock ledger, balances, reservations, invoices, payments or audit log',
  not exists (select 1 from unnest(array['inventory_transactions', 'inventory_balances', 'stock_reservations', 'sales_invoices', 'sales_invoice_lines',
      'customer_payments', 'invoice_payment_allocations', 'audit_logs', 'approval_decisions', 'fulfilments', 'fulfilment_lines', 'sales_orders', 'production_orders']) t
    where has_table_privilege('authenticated', 'public.' || t, 'INSERT') or has_any_column_privilege('authenticated', 'public.' || t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE')));

-- ---------------------------------------------------------------------------
-- Fixtures: test company RDA (state 27) with one user per role, company RDB
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'f1a11000-0000-4000-8000-0000000000a1'), ('company_b', 'f1a11000-0000-4000-8000-0000000000b1'),
  ('sadm', 'f1a11000-0000-4000-8000-000000000001'), ('adm', 'f1a11000-0000-4000-8000-000000000002'), ('im', 'f1a11000-0000-4000-8000-000000000003'),
  ('pm', 'f1a11000-0000-4000-8000-000000000004'), ('pm2', 'f1a11000-0000-4000-8000-000000000005'), ('pur', 'f1a11000-0000-4000-8000-000000000006'),
  ('sales', 'f1a11000-0000-4000-8000-000000000007'), ('acc', 'f1a11000-0000-4000-8000-000000000008'), ('viewer', 'f1a11000-0000-4000-8000-000000000009'),
  ('gone', 'f1a11000-0000-4000-8000-00000000000a'), ('b_adm', 'f1a11000-0000-4000-8000-00000000000b'), ('b_sales', 'f1a11000-0000-4000-8000-00000000000c');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;
insert into public.companies (id, legal_name, display_name, company_code, legal_address, state, gstin) values
  (rls_test.id('company_a'), 'Readiness Test A Pvt Ltd (TEST)', 'Readiness A', 'RDA', 'Plot 1, MIDC, Pune 411001', 'Maharashtra', '27AABCR1234F1Z5'),
  (rls_test.id('company_b'), 'Readiness Test B (TEST)', 'Readiness B', 'RDB', null, null, null);
-- V2 turns segregation of duties off by default (single operator). This suite tests it, so it switches it on.
insert into public.company_settings (company_id, setting_key, setting_value)
select id, 'inventory.segregation_of_duties', 'true'::jsonb from public.companies where id in (rls_test.id('company_a'), rls_test.id('company_b'));
insert into auth.users (id, email) select id, key || '@readiness.example.invalid' from rls_test.ids
  where key in ('sadm', 'adm', 'im', 'pm', 'pm2', 'pur', 'sales', 'acc', 'viewer', 'gone', 'b_adm', 'b_sales');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true
  where id in (select id from rls_test.ids where key in ('sadm', 'adm', 'im', 'pm', 'pm2', 'pur', 'sales', 'acc', 'viewer', 'gone'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id in (rls_test.id('b_adm'), rls_test.id('b_sales'));
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('sadm'), rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('adm'), rls_test.id('company_a'), rls_test.id('role_admin')),
  (rls_test.id('im'), rls_test.id('company_a'), rls_test.id('role_inventory_manager')),
  (rls_test.id('pm'), rls_test.id('company_a'), rls_test.id('role_production_manager')),
  (rls_test.id('pm2'), rls_test.id('company_a'), rls_test.id('role_production_manager')),
  (rls_test.id('pur'), rls_test.id('company_a'), rls_test.id('role_purchase_manager')),
  (rls_test.id('sales'), rls_test.id('company_a'), rls_test.id('role_sales_manager')),
  (rls_test.id('acc'), rls_test.id('company_a'), rls_test.id('role_accounts_manager')),
  (rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_management_viewer')),
  (rls_test.id('gone'), rls_test.id('company_a'), rls_test.id('role_sales_manager')),
  (rls_test.id('b_adm'), rls_test.id('company_b'), rls_test.id('role_admin')),
  (rls_test.id('b_sales'), rls_test.id('company_b'), rls_test.id('role_sales_manager'));
update public.profiles set is_active = false where id = rls_test.id('gone');

-- ===========================================================================
-- 2. END-TO-END SCENARIO (company RDA)
-- ===========================================================================
set local role authenticated;

-- Step 1: company and users
select rls_test.claims('adm');
select rls_test.expect_call_ok('E2E 1: the Admin''s access is resolved from the database (company, role, permissions)', 'access', $q$ select public.get_my_access() $q$);
select rls_test.ok('E2E 1: access belongs to the test company with the ADMIN role and users.manage',
  rls_test.get('access') #>> '{company,id}' = rls_test.id('company_a')::text and rls_test.get('access') -> 'roles' ? 'ADMIN'
  and rls_test.get('access') -> 'permissions' ? 'users.manage', left(rls_test.get('access')::text, 400));
select rls_test.claims('gone');
select rls_test.ok('E2E 1: a deactivated user gets no roles, no permissions and no data', jsonb_array_length(rls_test.call($q$ select public.get_my_access() $q$) -> 'permissions') = 0
  and jsonb_array_length(rls_test.call($q$ select public.get_my_access() $q$) -> 'roles') = 0 and (rls_test.call($q$ select public.get_my_access() $q$) #>> '{profile,is_active}')::boolean = false
  and not exists (select 1 from public.products), rls_test.call($q$ select public.get_my_access() $q$)::text);

-- Step 2: products (through the same table write the Product Master screen uses, under RLS)
select rls_test.claims('adm');
select rls_test.expect_call_ok('E2E 2: category created', 'cat', format($q$ insert into public.product_categories (company_id, name, code) values (%L, 'Sanitary ware (TEST)', 'SANT')
  returning jsonb_build_object('id', id) $q$, rls_test.id('company_a')));
select rls_test.expect_call_ok('E2E 2: finished product RD-BASIN created (PCS, HSN 6910, GST 18%)', 'basin',
  format($q$ insert into public.products (company_id, sku, product_name, category_id, product_type, default_source_type, base_unit, hsn_code, gst_rate, selling_price, is_manufacturable, standard_cost)
    values (%L, 'RD-BASIN', 'Wash basin (TEST)', %L, 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', '6910', 18, 1000, true, 400) returning jsonb_build_object('id', id) $q$,
    rls_test.id('company_a'), rls_test.gid('cat', 'id')));
select rls_test.expect_call_ok('E2E 2: raw material RD-CLAY created (KG)', 'clay',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, hsn_code, gst_rate, standard_cost)
    values (%L, 'RD-CLAY', 'Ceramic body (TEST)', 'RAW_MATERIAL', 'IN_HOUSE', 'KG', '2508', 5, 10) returning jsonb_build_object('id', id) $q$, rls_test.id('company_a')));
select rls_test.expect_call_error('E2E 2: a duplicate SKU in the same company is refused',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit) values (%L, 'rd-basin', 'Dup', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS')
    returning jsonb_build_object('id', id) $q$, rls_test.id('company_a')));
reset role;
insert into rls_test.ids values ('pa', rls_test.gid('basin', 'id')), ('clay', rls_test.gid('clay', 'id'));
set local role authenticated;

-- Step 3: warehouse and storage location
select rls_test.claims('im');
select rls_test.expect_call_ok('E2E 3: warehouse W1 created (a default GENERAL storage location comes with it)', 'w1',
  format($q$ insert into public.warehouses (company_id, warehouse_code, warehouse_name, is_default) values (%L, 'W1', 'Main store (TEST)', true) returning jsonb_build_object('id', id) $q$,
    rls_test.id('company_a')));
reset role;
insert into rls_test.ids values ('w1', rls_test.gid('w1', 'id'));
insert into rls_test.ids select 'g1', id from public.inventory_locations where warehouse_id = rls_test.id('w1') and location_code = 'GENERAL';
set local role authenticated;
select rls_test.ok('E2E 3: the GENERAL storage location exists and is eligible (STORAGE usage)',
  (select stock_usage from public.inventory_locations where id = rls_test.id('g1')) = 'STORAGE');

-- Step 4: opening stock through submit -> approve (segregation of duties)
select rls_test.claims('im');
select rls_test.expect_call_ok('E2E 4: opening stock submitted (clay 500 KG, basin 20 PCS)', 'open',
  format($q$ select public.inventory_submit_opening_stock_at_cost(%L::jsonb, 'MANUAL', null, 'Readiness test', gen_random_uuid()) $q$, jsonb_build_array(
    jsonb_build_object('line_no', 1, 'product_id', rls_test.id('clay'), 'location_id', rls_test.id('g1'), 'source_type', 'IN_HOUSE', 'quantity', 500, 'effective_date', rls_test.today(), 'unit_cost', 10),
    jsonb_build_object('line_no', 2, 'product_id', rls_test.id('pa'), 'location_id', rls_test.id('g1'), 'source_type', 'IN_HOUSE', 'quantity', 20, 'effective_date', rls_test.today(), 'unit_cost', 400))));
select rls_test.ok('E2E 4: nothing is posted before approval', rls_test.on_hand(rls_test.id('clay')) = 0 and rls_test.tx_count(rls_test.id('company_a')) = 0);
select rls_test.expect_call_error('E2E 4: the submitter cannot approve their own opening stock',
  format($q$ select public.inventory_review_opening_stock(%L, 'APPROVE', null, gen_random_uuid()) $q$, rls_test.gid('open', 'opening_batch_id')));
select rls_test.claims('adm');
select rls_test.expect_call_ok('E2E 4: Admin approves and posts the opening stock', 'open_ok',
  format($q$ select public.inventory_review_opening_stock(%L, 'APPROVE', 'checked', gen_random_uuid()) $q$, rls_test.gid('open', 'opening_batch_id')));
select rls_test.ok('E2E 4: on hand = clay 500, basin 20; 2 OPENING_STOCK movements',
  rls_test.on_hand(rls_test.id('clay')) = 500 and rls_test.on_hand(rls_test.id('pa')) = 20
  and (select count(*) from public.inventory_transactions where company_id = rls_test.id('company_a') and transaction_type = 'OPENING_STOCK') = 2);

-- Step 5: BOM and approved production order
select rls_test.claims('pm');
select rls_test.expect_call_ok('E2E 5: BOM v1 saved (2.5 KG clay per basin)', 'bom',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('pa'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('clay'), 'quantity_required', 2.5))));
select rls_test.call(format($q$ select public.production_bom_action(%L, 'SUBMIT') $q$, rls_test.gid('bom', 'bom_id')));
select rls_test.expect_call_error('E2E 5: the author cannot approve their own BOM', format($q$ select public.production_bom_action(%L, 'APPROVE') $q$, rls_test.gid('bom', 'bom_id')));
select rls_test.claims('pm2');
select rls_test.expect_call_ok('E2E 5: a second Production Manager approves the BOM', 'bom_ok', format($q$ select public.production_bom_action(%L, 'APPROVE') $q$, rls_test.gid('bom', 'bom_id')));
select rls_test.claims('pm');
select rls_test.expect_call_ok('E2E 5: production order for 40 basins saved', 'po1',
  format($q$ select public.production_save_order(null, %L, 40, %L, %L, %L, %L, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('bom', 'bom_id'), rls_test.id('w1'), rls_test.id('w1'), rls_test.today(), rls_test.today() + 7));
select rls_test.call(format($q$ select public.production_order_action(%L, 'SUBMIT') $q$, rls_test.gid('po1', 'order_id')));
select rls_test.claims('pm2');
select rls_test.expect_call_ok('E2E 5: production order approved by another manager', 'po1_ok', format($q$ select public.production_order_action(%L, 'APPROVE') $q$, rls_test.gid('po1', 'order_id')));

-- Step 6: reserve and issue materials
select rls_test.claims('pm');
select rls_test.expect_call_ok('E2E 6: materials reserved for the order (100 KG clay)', 'reserve',
  format($q$ select public.production_reserve_materials(%L, false, gen_random_uuid()) $q$, rls_test.gid('po1', 'order_id')));
select rls_test.ok('E2E 6: reservation reduces availability, not on hand (clay on hand 500, reserved 100)',
  rls_test.on_hand(rls_test.id('clay')) = 500 and rls_test.reserved(rls_test.id('clay')) = 100);
select rls_test.expect_call_ok('E2E 6: production started', 'start', format($q$ select public.production_order_action(%L, 'START') $q$, rls_test.gid('po1', 'order_id')));
select rls_test.set('issue_key', to_jsonb(gen_random_uuid()));
select rls_test.expect_call_ok('E2E 6: 100 KG clay issued to the order', 'issue',
  format($q$ select public.production_issue_materials(%L, %L::jsonb, p_idempotency_key => %L) $q$, rls_test.gid('po1', 'order_id'),
    jsonb_build_array(jsonb_build_object('order_material_id', rls_test.material(rls_test.gid('po1', 'order_id'), rls_test.id('clay')),
      'batch_id', rls_test.lot(rls_test.id('clay')), 'location_id', rls_test.id('g1'), 'quantity', 100)), rls_test.get('issue_key') #>> '{}'));
select rls_test.call(format($q$ select public.production_issue_materials(%L, %L::jsonb, p_idempotency_key => %L) $q$, rls_test.gid('po1', 'order_id'),
    jsonb_build_array(jsonb_build_object('order_material_id', rls_test.material(rls_test.gid('po1', 'order_id'), rls_test.id('clay')),
      'batch_id', rls_test.lot(rls_test.id('clay')), 'location_id', rls_test.id('g1'), 'quantity', 100)), rls_test.get('issue_key') #>> '{}'));
select rls_test.ok('E2E 6: issue posted once even when retried with the same key (clay 400, reservation consumed)',
  rls_test.on_hand(rls_test.id('clay')) = 400 and rls_test.reserved(rls_test.id('clay')) = 0
  and (select count(*) from public.inventory_transactions where product_id = rls_test.id('clay') and direction = -1) = 1,
  format('on_hand=%s reserved=%s issues=%s issue=%s', rls_test.on_hand(rls_test.id('clay')), rls_test.reserved(rls_test.id('clay')),
    (select string_agg(transaction_type || ':' || quantity, ',') from public.inventory_transactions where product_id = rls_test.id('clay') and direction = -1), rls_test.get('issue')));

-- Step 7: finished goods receipt and completion
select rls_test.expect_call_ok('E2E 7: output recorded: 38 good, 2 scrap', 'output',
  format($q$ select public.production_receive_output(%L, 38, 0, 2, %L, p_rejection_reason => 'Cracked in firing (TEST)', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('po1', 'order_id'), rls_test.id('g1')));
select rls_test.ok('E2E 7: only good output enters stock (basin 20 + 38 = 58); scrap is not stock',
  rls_test.on_hand(rls_test.id('pa')) = 58, rls_test.on_hand(rls_test.id('pa'))::text);
select rls_test.expect_call_ok('E2E 7: production order completed', 'complete', format($q$ select public.production_order_action(%L, 'COMPLETE') $q$, rls_test.gid('po1', 'order_id')));
select rls_test.ok('E2E 7: order records 38 completed, 2 scrap, status COMPLETED',
  (select status = 'COMPLETED' and completed_quantity = 38 and scrap_quantity = 2 from public.production_orders where id = rls_test.gid('po1', 'order_id')));

-- Step 8: customer and customer PO import (one unknown SKU)
select rls_test.claims('sales');
select rls_test.expect_call_ok('E2E 8: customer created', 'cu1',
  format($q$ insert into public.customers (company_id, customer_code, customer_name) values (%L, 'C-TEST', 'Pune Traders (TEST)') returning jsonb_build_object('id', id) $q$,
    rls_test.id('company_a')));
reset role;
insert into rls_test.ids values ('cu1', rls_test.gid('cu1', 'id'));
set local role authenticated;
select rls_test.claims('sales');
select rls_test.ok('E2E 8: customer GST details (GSTIN, state 27) saved through the customer master',
  rls_test.call(format($q$ with u as (update public.customers set legal_name = 'Pune Traders LLP (TEST)', gstin = '27PQRST5678K1Z2',
     gst_registration_type = 'REGISTERED', billing_address = 'Kothrud, Pune', billing_state_code = '27', payment_terms_days = 30 where id = %L returning id)
     select jsonb_build_object('n', count(*)) from u $q$, rls_test.id('cu1'))) ->> 'n' = '1');
select rls_test.set('stock_before_po', jsonb_build_object('tx', rls_test.tx_count(rls_test.id('company_a')), 'products', (select count(*) from public.products)));
select rls_test.set('po_key', to_jsonb(gen_random_uuid()));
select rls_test.expect_call_ok('E2E 8: customer PO TEST-PO-1 imported (RD-BASIN 30 @ 1000, unknown ZZ-404 x 2)', 'cpo',
  format($q$ select public.customer_po_import(%L::jsonb, %L::jsonb, '{"name": "test-po-1.xlsx", "rows_read": 2}'::jsonb, null, %L) $q$,
    jsonb_build_object('customer_id', rls_test.id('cu1'), 'customer_po_number', 'TEST-PO-1', 'po_date', rls_test.today(), 'required_delivery_date', rls_test.today() + 5, 'currency', 'INR'),
    jsonb_build_array(jsonb_build_object('source_row_number', 2, 'sku', 'RD-BASIN', 'quantity', 30, 'unit_price', 1000),
                      jsonb_build_object('source_row_number', 3, 'sku', 'ZZ-404', 'description', 'Unknown item', 'quantity', 2)), rls_test.get('po_key') #>> '{}'));
select rls_test.call(format($q$ select public.customer_po_import(%L::jsonb, %L::jsonb, '{"name": "test-po-1.xlsx", "rows_read": 2}'::jsonb, null, %L) $q$,
    jsonb_build_object('customer_id', rls_test.id('cu1'), 'customer_po_number', 'TEST-PO-1', 'po_date', rls_test.today(), 'required_delivery_date', rls_test.today() + 5, 'currency', 'INR'),
    jsonb_build_array(jsonb_build_object('source_row_number', 2, 'sku', 'RD-BASIN', 'quantity', 30, 'unit_price', 1000),
                      jsonb_build_object('source_row_number', 3, 'sku', 'ZZ-404', 'description', 'Unknown item', 'quantity', 2)), rls_test.get('po_key') #>> '{}'));
select rls_test.expect_call_ok('E2E 8: the same PO number uploaded again (new request) is refused as a duplicate', 'cpo_dup',
  format($q$ select public.customer_po_import(%L::jsonb, %L::jsonb, '{"name": "test-po-1-copy.xlsx", "rows_read": 1}'::jsonb, null, gen_random_uuid()) $q$,
    jsonb_build_object('customer_id', rls_test.id('cu1'), 'customer_po_number', 'TEST-PO-1', 'po_date', rls_test.today(), 'currency', 'INR'),
    jsonb_build_array(jsonb_build_object('source_row_number', 2, 'sku', 'RD-BASIN', 'quantity', 30))));
select rls_test.ok('E2E 8: the duplicate upload was refused with reason DUPLICATE_PO pointing to the existing PO',
  (rls_test.get('cpo_dup') ->> 'ok')::boolean = false and rls_test.get('cpo_dup') ->> 'reason' = 'DUPLICATE_PO'
  and rls_test.get('cpo_dup') #>> '{existing,po_id}' = rls_test.gid('cpo', 'po_id')::text, rls_test.get('cpo_dup')::text);
select rls_test.ok('E2E 8: exactly one PO exists; the import changed no stock and created no product',
  (select count(*) from public.customer_purchase_orders where company_id = rls_test.id('company_a')) = 1
  and rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('stock_before_po') ->> 'tx')::bigint
  and (select count(*) from public.products) = (rls_test.get('stock_before_po') ->> 'products')::bigint);

-- Step 9: matching
select rls_test.ok('E2E 9: the known SKU matched exactly; the unknown SKU is left unmatched (not guessed)',
  (select product_id = rls_test.id('pa') from public.customer_purchase_order_lines where id = rls_test.po_line(rls_test.gid('cpo', 'po_id'), 1))
  and (select product_id is null from public.customer_purchase_order_lines where id = rls_test.po_line(rls_test.gid('cpo', 'po_id'), 2)));
select rls_test.expect_call_ok('E2E 9: the unknown line is excluded by the user with a note', 'exclude',
  format($q$ select public.customer_po_line_action(%L, 'EXCLUDE', p_note => 'Not our product (TEST)') $q$, rls_test.po_line(rls_test.gid('cpo', 'po_id'), 2)));

-- Step 10: availability
select rls_test.expect_call_ok('E2E 10: availability analysis runs on the inventory and reservation data', 'analysis',
  format($q$ select public.customer_po_analysis(%L) $q$, rls_test.gid('cpo', 'po_id')));
select rls_test.ok('E2E 10: 58 basins available for the 30 still needed; no shortage before allocation',
  (select (l ->> 'available')::numeric = 58 and (l ->> 'remaining_need')::numeric = 30 and (l ->> 'shortage_before')::numeric = 0
   from jsonb_array_elements(rls_test.get('analysis') -> 'lines') l where l ->> 'product_id' = rls_test.id('pa')::text), left((rls_test.get('analysis') -> 'lines')::text, 800));

-- Step 11-12: sales order from the PO, confirmation, allocation
select rls_test.set('so_key', to_jsonb(gen_random_uuid()));
select rls_test.expect_call_ok('E2E 11: sales order created from the PO', 'so',
  format($q$ select public.sales_order_create_from_po(%L, '{}'::jsonb, null, false, false, %L) $q$, rls_test.gid('cpo', 'po_id'), rls_test.get('so_key') #>> '{}'));
select rls_test.call(format($q$ select public.sales_order_create_from_po(%L, '{}'::jsonb, null, false, false, %L) $q$, rls_test.gid('cpo', 'po_id'), rls_test.get('so_key') #>> '{}'));
select rls_test.ok('E2E 11: retrying the conversion did not create a second order (one order, one basin line of 30)',
  (select count(*) from public.sales_orders where customer_purchase_order_id = rls_test.gid('cpo', 'po_id')) = 1
  and (select count(*) || ':' || sum(quantity_ordered) from public.sales_order_lines where sales_order_id = rls_test.gid('so', 'sales_order_id')) = '1:30.000');
select rls_test.expect_call_ok('E2E 11: sales order confirmed', 'so_conf', format($q$ select public.sales_order_confirm(%L) $q$, rls_test.gid('so', 'sales_order_id')));
select rls_test.expect_call_ok('E2E 12: stock allocated to the order (30 reserved)', 'alloc',
  format($q$ select public.sales_order_allocate(%L, 'IN_HOUSE_FIRST', null, true, gen_random_uuid()) $q$, rls_test.gid('so', 'sales_order_id')));
select rls_test.ok('E2E 12: reserved 30 of 58; on hand unchanged', rls_test.reserved(rls_test.id('pa')) = 30 and rls_test.on_hand(rls_test.id('pa')) = 58);
select rls_test.claims('im');
select rls_test.expect_call_error('E2E 12: a manual reservation cannot take more than the remaining 28 available',
  format($q$ select public.inventory_create_reservation(%L, %L, 29, 'MANUAL', 'TEST-OVER', p_source_type => 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.id('pa'), rls_test.id('g1')));
select rls_test.expect_call_error('E2E 12: an issue cannot take reserved stock or go negative (issue 29 of 28 free)',
  format($q$ select public.inventory_post_issue(%L, %L, 29, p_source_type => 'IN_HOUSE', p_reason => 'Over-issue attempt', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.id('pa'), rls_test.id('g1')));

-- Step 13-14: pick, pack, dispatch
select rls_test.expect_call_ok('E2E 13: consignment created for the order', 'ful',
  format($q$ select public.fulfilment_create(%L, %L, null, null, null, gen_random_uuid()) $q$, rls_test.gid('so', 'sales_order_id'), rls_test.id('w1')));
select rls_test.set('tx_before_pick', to_jsonb(rls_test.tx_count(rls_test.id('company_a'))));
select rls_test.expect_call_error('E2E 13: picking more than planned is refused',
  format($q$ select public.fulfilment_pick(%L, %L::jsonb, true) $q$, rls_test.gid('ful', 'fulfilment_id'),
    jsonb_build_array(jsonb_build_object('line_id', rls_test.fl(rls_test.gid('ful', 'fulfilment_id'), rls_test.id('pa')), 'quantity_picked', 31))));
select rls_test.expect_call_ok('E2E 13: 30 picked', 'pick', format($q$ select public.fulfilment_pick(%L, %L::jsonb, true) $q$, rls_test.gid('ful', 'fulfilment_id'),
    jsonb_build_array(jsonb_build_object('line_id', rls_test.fl(rls_test.gid('ful', 'fulfilment_id'), rls_test.id('pa')), 'quantity_picked', 30))));
select rls_test.ok('E2E 13: picking posted no stock movement', rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx_before_pick') #>> '{}')::bigint);
select rls_test.expect_call_error('E2E 13: packing more than picked is refused',
  format($q$ select public.fulfilment_pack(%L, %L::jsonb, null, true) $q$, rls_test.gid('ful', 'fulfilment_id'),
    jsonb_build_array(jsonb_build_object('line_id', rls_test.fl(rls_test.gid('ful', 'fulfilment_id'), rls_test.id('pa')), 'quantity_packed', 31))));
select rls_test.expect_call_ok('E2E 13: 30 packed', 'pack', format($q$ select public.fulfilment_pack(%L, %L::jsonb, null, true) $q$, rls_test.gid('ful', 'fulfilment_id'),
    jsonb_build_array(jsonb_build_object('line_id', rls_test.fl(rls_test.gid('ful', 'fulfilment_id'), rls_test.id('pa')), 'quantity_packed', 30))));
select rls_test.call(format($q$ select public.fulfilment_action(%L, 'READY') $q$, rls_test.gid('ful', 'fulfilment_id')));
select rls_test.set('disp_key', to_jsonb(gen_random_uuid()));
select rls_test.expect_call_ok('E2E 14: dispatch confirmed', 'disp',
  format($q$ select public.fulfilment_dispatch(%L, '{"vehicle_number": "MH12TEST1"}'::jsonb, %L) $q$, rls_test.gid('ful', 'fulfilment_id'), rls_test.get('disp_key') #>> '{}'));
select rls_test.call(format($q$ select public.fulfilment_dispatch(%L, '{"vehicle_number": "MH12TEST1"}'::jsonb, %L) $q$, rls_test.gid('ful', 'fulfilment_id'), rls_test.get('disp_key') #>> '{}'));
select rls_test.expect_call_error('E2E 14: a second dispatch of the same consignment (new key) is refused',
  format($q$ select public.fulfilment_dispatch(%L, '{"vehicle_number": "MH12TEST1"}'::jsonb, gen_random_uuid()) $q$, rls_test.gid('ful', 'fulfilment_id')));

-- Step 15: ledger
select rls_test.ok('E2E 15: dispatch posted exactly one ISSUE of 30 basins; on hand 28, nothing reserved',
  (select count(*) || ':' || sum(quantity) from public.inventory_transactions where product_id = rls_test.id('pa') and transaction_type = 'ISSUE') = '1:30.000'
  and rls_test.on_hand(rls_test.id('pa')) = 28 and rls_test.reserved(rls_test.id('pa')) = 0,
  (select string_agg(transaction_type || ' ' || quantity, ', ') from public.inventory_transactions where product_id = rls_test.id('pa')));
select rls_test.ok('E2E 15: order line shows 30 dispatched, 0 remaining',
  (select quantity_dispatched = 30 from public.sales_order_lines where sales_order_id = rls_test.gid('so', 'sales_order_id')));

-- Step 16-17: invoice and GST
select rls_test.claims('acc');
select rls_test.set('inv_key', to_jsonb(gen_random_uuid()));
select rls_test.expect_call_ok('E2E 16: draft invoice created from the dispatched consignment line', 'inv',
  format($q$ select public.sales_invoice_create_draft(%L::jsonb, '{}'::jsonb, %L) $q$,
    jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.fl(rls_test.gid('ful', 'fulfilment_id'), rls_test.id('pa')))), rls_test.get('inv_key') #>> '{}'));
select rls_test.expect_call_error('E2E 16: the same dispatched quantity cannot go on a second invoice',
  format($q$ select public.sales_invoice_create_draft(%L::jsonb, '{}'::jsonb, gen_random_uuid()) $q$,
    jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.fl(rls_test.gid('ful', 'fulfilment_id'), rls_test.id('pa')), 'quantity', 1))));
select rls_test.expect_call_ok('E2E 16: invoice issued', 'issued', format($q$ select public.sales_invoice_issue(%L, gen_random_uuid()) $q$, rls_test.gid('inv', 'invoice_id')));
select rls_test.ok('E2E 17: GST intra-state 27 -> 27: taxable 30000, CGST 2700 + SGST 2700, IGST 0, total 35400',
  (select tax_treatment = 'INTRA_STATE' and taxable_subtotal = 30000 and cgst_total = 2700 and sgst_total = 2700 and igst_total = 0 and grand_total = 35400
   from public.sales_invoices where id = rls_test.gid('inv', 'invoice_id')),
  (select row(tax_treatment, taxable_subtotal, cgst_total, sgst_total, igst_total, grand_total)::text from public.sales_invoices where id = rls_test.gid('inv', 'invoice_id')));
select rls_test.ok('E2E 17: header totals equal the sum of the lines (taxable, CGST, SGST, line totals)',
  (select i.taxable_subtotal = sum(l.taxable_value) and i.cgst_total = sum(l.cgst_amount) and i.sgst_total = sum(l.sgst_amount)
     and i.other_charges_total = 0 and i.grand_total = sum(l.line_total) + i.round_off
   from public.sales_invoices i join public.sales_invoice_lines l on l.invoice_id = i.id where i.id = rls_test.gid('inv', 'invoice_id') group by i.id));
select rls_test.ok('E2E 17: invoice number assigned at issue, in the financial-year series, quantity 30 = dispatched 30',
  (select invoice_number is not null and invoice_number like '%' || '/0001' from public.sales_invoices where id = rls_test.gid('inv', 'invoice_id'))
  and (select sum(quantity) from public.sales_invoice_lines where invoice_id = rls_test.gid('inv', 'invoice_id')) = 30,
  (select invoice_number from public.sales_invoices where id = rls_test.gid('inv', 'invoice_id')));
select rls_test.expect_call_error('E2E 17: issuing the same invoice again is refused',
  format($q$ select public.sales_invoice_issue(%L, gen_random_uuid()) $q$, rls_test.gid('inv', 'invoice_id')));

-- Step 18-21: payments and receivables
select rls_test.set('pay_key', to_jsonb(gen_random_uuid()));
select rls_test.expect_call_ok('E2E 18: partial payment of 15000 recorded and allocated', 'pay1',
  format($q$ select public.customer_payment_record(%L::jsonb, %L::jsonb, %L) $q$,
    jsonb_build_object('customer_id', rls_test.id('cu1'), 'amount', 15000, 'payment_method', 'BANK_TRANSFER', 'transaction_reference', 'UTR-TEST-1'),
    jsonb_build_array(jsonb_build_object('invoice_id', rls_test.gid('inv', 'invoice_id'), 'amount', 15000)), rls_test.get('pay_key') #>> '{}'));
select rls_test.call(format($q$ select public.customer_payment_record(%L::jsonb, %L::jsonb, %L) $q$,
    jsonb_build_object('customer_id', rls_test.id('cu1'), 'amount', 15000, 'payment_method', 'BANK_TRANSFER', 'transaction_reference', 'UTR-TEST-1'),
    jsonb_build_array(jsonb_build_object('invoice_id', rls_test.gid('inv', 'invoice_id'), 'amount', 15000)), rls_test.get('pay_key') #>> '{}'));
select rls_test.ok('E2E 19: retry did not duplicate; balance 35400 - 15000 = 20400, PARTIALLY_PAID',
  (select count(*) from public.customer_payments where company_id = rls_test.id('company_a')) = 1 and rls_test.inv_bal(rls_test.gid('inv', 'invoice_id')) = 20400
  and (select payment_status from public.sales_invoice_list where id = rls_test.gid('inv', 'invoice_id')) = 'PARTIALLY_PAID');
select rls_test.ok('E2E 19: receivables report shows 20400 outstanding for the customer',
  (select sum((r ->> 'balance')::numeric) from public.billing_receivables(rls_test.today(), rls_test.id('cu1')) r) = 20400,
  (select string_agg(r::text, ' ') from public.billing_receivables(rls_test.today(), rls_test.id('cu1')) r));
select rls_test.expect_call_ok('E2E 20: second receipt of 25000 recorded on account', 'pay2',
  format($q$ select public.customer_payment_record(%L::jsonb, null, gen_random_uuid()) $q$,
    jsonb_build_object('customer_id', rls_test.id('cu1'), 'amount', 25000, 'payment_method', 'CHEQUE', 'transaction_reference', 'CHQ-TEST-2')));
select rls_test.expect_call_error('E2E 20: allocation above the invoice balance is refused',
  format($q$ select public.customer_payment_allocate(%L, %L::jsonb, gen_random_uuid()) $q$, rls_test.gid('pay2', 'payment_id'),
    jsonb_build_array(jsonb_build_object('invoice_id', rls_test.gid('inv', 'invoice_id'), 'amount', 20400.01))), 'balance');
select rls_test.expect_call_ok('E2E 20: 20400 allocated, completing the invoice', 'alloc2',
  format($q$ select public.customer_payment_allocate(%L, %L::jsonb, gen_random_uuid()) $q$, rls_test.gid('pay2', 'payment_id'),
    jsonb_build_array(jsonb_build_object('invoice_id', rls_test.gid('inv', 'invoice_id'), 'amount', 20400))));
select rls_test.ok('E2E 21: invoice PAID with balance 0; 4600 of the second receipt remains unallocated',
  rls_test.inv_bal(rls_test.gid('inv', 'invoice_id')) = 0 and (select payment_status from public.sales_invoice_list where id = rls_test.gid('inv', 'invoice_id')) = 'PAID'
  and (select unallocated_amount from public.customer_payment_list where id = rls_test.gid('pay2', 'payment_id')) = 4600);

-- Step 22: executive dashboard against the source records
select rls_test.claims('adm');
select rls_test.expect_call_ok('E2E 22: executive dashboard loads for the last 30 days', 'ex',
  format($q$ select public.analytics_executive(%L, %L) $q$, rls_test.today() - 30, rls_test.today()));
select rls_test.ok('E2E 22: order value 30000 = 30 x 1000 price snapshot; dispatched value 30000',
  rls_test.n('ex', '{sales,order_value}') = 30000 and rls_test.n('ex', '{sales,dispatched_value}') = 30000, rls_test.get('ex') ->> 'sales');
select rls_test.ok('E2E 22: invoiced 35400 = issued invoice total; collections 40000 = receipts; outstanding 0; unallocated 4600',
  rls_test.n('ex', '{billing,invoiced_total}') = (select sum(grand_total) from public.sales_invoices where company_id = rls_test.id('company_a') and status = 'ISSUED')
  and rls_test.n('ex', '{billing,invoiced_total}') = 35400 and rls_test.n('ex', '{billing,payments_received}') = 40000
  and rls_test.n('ex', '{billing,outstanding}') = 0 and rls_test.n('ex', '{billing,unallocated_receipts}') = 4600, rls_test.get('ex') ->> 'billing');
select rls_test.ok('E2E 22: stock KPIs equal the balances: PCS on hand 28, available 28, reserved 0; KG on hand 400',
  rls_test.pick(rls_test.get('ex') #> '{inventory,units}', 'unit', 'PCS', 'on_hand') = rls_test.on_hand(rls_test.id('pa'))
  and rls_test.pick(rls_test.get('ex') #> '{inventory,units}', 'unit', 'PCS', 'on_hand') = 28
  and rls_test.pick(rls_test.get('ex') #> '{inventory,units}', 'unit', 'PCS', 'available') = 28
  and rls_test.pick(rls_test.get('ex') #> '{inventory,units}', 'unit', 'PCS', 'reserved') = 0
  and rls_test.pick(rls_test.get('ex') #> '{inventory,units}', 'unit', 'KG', 'on_hand') = 400, rls_test.get('ex') #>> '{inventory,units}');
select rls_test.ok('E2E 22: production output in the period = 38 good, 2 scrap (posted records, not the plan of 40)',
  rls_test.pick(rls_test.get('ex') #> '{production,output_in_period}', 'unit', 'PCS', 'good') = 38
  and rls_test.pick(rls_test.get('ex') #> '{production,output_in_period}', 'unit', 'PCS', 'scrap') = 2, rls_test.get('ex') ->> 'production');
select rls_test.expect_call_ok('E2E 22: finance analytics loads for the same period', 'fin',
  format($q$ select public.analytics_finance(%L, %L) $q$, rls_test.today() - 30, rls_test.today()));
select rls_test.ok('E2E 22: finance totals agree with the executive dashboard (invoiced, collected, outstanding)',
  rls_test.n('fin', '{totals,invoiced}') = rls_test.n('ex', '{billing,invoiced_total}') and rls_test.n('fin', '{totals,collected}') = rls_test.n('ex', '{billing,payments_received}')
  and rls_test.n('fin', '{totals,outstanding}') = rls_test.n('ex', '{billing,outstanding}'), rls_test.get('fin') ->> 'totals');
select rls_test.ok('E2E 22: an empty period returns zero activity, not an error',
  (rls_test.call(format($q$ select public.analytics_executive(%L, %L) $q$, rls_test.today() - 400, rls_test.today() - 380)) #>> '{sales,order_value}')::numeric = 0);

-- Step 23: audit trail
reset role;
select rls_test.set('audit_modules', (select to_jsonb(array_agg(distinct split_part(action, '.', 1) order by split_part(action, '.', 1)))
  from public.audit_logs where company_id = rls_test.id('company_a')));
set local role authenticated;
select rls_test.ok('E2E 23: the audit log holds events from inventory, production, customer POs, sales/fulfilment and billing',
  (select bool_and(rls_test.get('audit_modules') ? m) from unnest(array['inventory', 'production', 'customer_po', 'billing']) m)
  and (rls_test.get('audit_modules') ? 'sales' or rls_test.get('audit_modules') ? 'fulfilment'), rls_test.get('audit_modules')::text);
select rls_test.claims('adm');
select rls_test.ok('E2E 23: Admin (audit_logs.read) can read the company audit trail', (select count(*) from public.audit_logs) > 10);
select rls_test.expect_blocked('E2E 23: Admin cannot edit an audit event', 'update public.audit_logs set action = action');
select rls_test.expect_blocked('E2E 23: Admin cannot delete audit events', 'delete from public.audit_logs');
select rls_test.claims('sales');
select rls_test.ok('E2E 23: users without audit_logs.read see no audit events', (select count(*) from public.audit_logs) = 0);

-- ===========================================================================
-- 3. LEDGER AND RESERVATION INVARIANTS
-- ===========================================================================
reset role;
select rls_test.ok('ledger: every company A balance equals the sum of its posted movements', rls_test.ledger_mismatches(rls_test.id('company_a')) is null,
  rls_test.ledger_mismatches(rls_test.id('company_a')));
select rls_test.ok('ledger: reserved quantities equal the open reservations', rls_test.reservation_mismatches(rls_test.id('company_a')) is null,
  rls_test.reservation_mismatches(rls_test.id('company_a')));
select rls_test.ok('ledger: no balance is negative or reserves more than it holds',
  not exists (select 1 from public.inventory_balances where on_hand < 0 or reserved < 0 or reserved > on_hand));
select rls_test.ok('ledger: the invariants hold for every company in this database (including seeded data)',
  rls_test.ledger_mismatches() is null and rls_test.reservation_mismatches() is null, coalesce(rls_test.ledger_mismatches(), '') || coalesce(rls_test.reservation_mismatches(), ''));

-- ===========================================================================
-- 4. CROSS-COMPANY ISOLATION (company RDB has its own records)
-- ===========================================================================
set local role authenticated;
select rls_test.claims('b_adm');
select rls_test.call(format($q$ insert into public.warehouses (company_id, warehouse_code, warehouse_name, is_default) values (%L, 'WB', 'B store (TEST)', true)
  returning jsonb_build_object('id', id) $q$, rls_test.id('company_b')));
select rls_test.set('b_prod', rls_test.call(format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit)
  values (%L, 'RD-BASIN', 'Company B basin (same SKU, TEST)', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS') returning jsonb_build_object('id', id) $q$, rls_test.id('company_b'))));
select rls_test.ok('isolation: company B may use the same SKU as company A (uniqueness is per company)', rls_test.get('b_prod') ? 'id', rls_test.get('b_prod')::text);
select rls_test.set('iso_b', rls_test.foreign_rows_visible(rls_test.id('company_a')));
select rls_test.ok('isolation: company B Admin sees ZERO company A rows across every company-scoped table and view',
  jsonb_array_length(rls_test.get('iso_b') -> 'leaks') = 0 and (rls_test.get('iso_b') ->> 'checked')::int >= 60, rls_test.get('iso_b')::text);
select rls_test.set('iso_bw', rls_test.foreign_rows_writable(rls_test.id('company_a')));
select rls_test.ok('isolation: company B Admin can change ZERO company A rows through any directly updatable table',
  jsonb_array_length(rls_test.get('iso_bw') -> 'leaks') = 0 and (rls_test.get('iso_bw') ->> 'checked')::int >= 5, rls_test.get('iso_bw')::text);
select rls_test.claims('adm');
select rls_test.set('iso_a', rls_test.foreign_rows_visible(rls_test.id('company_b')));
select rls_test.ok('isolation: company A Admin sees ZERO company B rows', jsonb_array_length(rls_test.get('iso_a') -> 'leaks') = 0, rls_test.get('iso_a')::text);
select rls_test.claims('b_adm');
select rls_test.expect_call_error('isolation: B cannot post stock against A''s product and location',
  format($q$ select public.inventory_post_receipt(%L, %L, 5, 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('pa'), rls_test.id('g1')));
select rls_test.expect_call_error('isolation: B cannot issue A''s stock',
  format($q$ select public.inventory_post_issue(%L, %L, 1, p_source_type => 'IN_HOUSE', p_reason => 'x', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('pa'), rls_test.id('g1')));
select rls_test.expect_call_error('isolation: B cannot act on A''s production order',
  format($q$ select public.production_order_action(%L, 'CANCEL') $q$, rls_test.gid('po1', 'order_id')));
select rls_test.expect_call_error('isolation: B cannot convert, allocate or dispatch A''s orders',
  format($q$ select public.sales_order_allocate(%L, 'IN_HOUSE_FIRST', null, true, gen_random_uuid()) $q$, rls_test.gid('so', 'sales_order_id')));
select rls_test.expect_call_error('isolation: B cannot record a payment for A''s customer',
  format($q$ select public.customer_payment_record(%L::jsonb, null, gen_random_uuid()) $q$, jsonb_build_object('customer_id', rls_test.id('cu1'), 'amount', 1, 'payment_method', 'UPI')));
select rls_test.expect_call_error('isolation: B cannot invoice A''s dispatch',
  format($q$ select public.sales_invoice_create_draft(%L::jsonb, '{}'::jsonb, gen_random_uuid()) $q$,
    jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.fl(rls_test.gid('ful', 'fulfilment_id'), rls_test.id('pa'))))));
select rls_test.expect_call_error('isolation: B cannot read A''s PO analysis', format($q$ select public.customer_po_analysis(%L) $q$, rls_test.gid('cpo', 'po_id')));
select rls_test.ok('isolation: scanning A''s SKU in company B finds only B''s own product',
  (select bool_and(m ->> 'id' = rls_test.gid('b_prod', 'id')::text) from jsonb_array_elements(public.barcode_lookup('RD-BASIN') -> 'matches') m));
select rls_test.expect_call_error('isolation: B cannot insert a record into company A',
  format($q$ insert into public.customers (company_id, customer_code, customer_name) values (%L, 'X', 'Injected') returning jsonb_build_object('id', id) $q$, rls_test.id('company_a')));

-- Phase 11 rewrote 8 high-volume SELECT policies for performance. For several kinds of user,
-- the rows visible through RLS must equal the rows the ORIGINAL predicate would allow.
reset role;
create function rls_test.policy_diff(p_user text) returns text language plpgsql as $$
declare t record; v_rls bigint; v_orig bigint; diffs text[] := '{}';
begin
  for t in select * from (values ('inventory_transactions', 'private.has_permission(company_id, ''inventory.read'')'),
      ('inventory_balances', 'private.has_permission(company_id, ''inventory.read'')'),
      ('stock_reservations', 'private.has_permission(company_id, ''inventory.read'')'),
      ('products', 'private.has_permission(company_id, ''products.read'')'),
      ('inventory_batches', 'private.has_permission(company_id, ''inventory.read'') or private.has_permission(company_id, ''inventory_batch.read'')'),
      ('warehouses', 'private.has_permission(company_id, ''inventory.read'') or private.has_permission(company_id, ''inventory_warehouse.manage'')'),
      ('inventory_locations', 'private.has_permission(company_id, ''inventory.read'') or private.has_permission(company_id, ''inventory_location.manage'')'),
      ('audit_logs', 'company_id is not null and private.has_permission(company_id, ''audit_logs.read'')')) v(tbl, pred) loop
    perform rls_test.claims(p_user);
    execute format('select count(*) from public.%I where %s', t.tbl, t.pred) into v_orig;   -- as owner: no RLS, original rule
    set local role authenticated;
    execute format('select count(*) from public.%I', t.tbl) into v_rls;                     -- through the new policy
    reset role;
    if v_rls <> v_orig then diffs := diffs || format('%s rls=%s original=%s', t.tbl, v_rls, v_orig); end if;
  end loop;
  return array_to_string(diffs, '; ');
end $$;
select rls_test.ok('policy rewrite: visible rows equal the original rule for Admin, Inventory, Sales, Viewer, a deactivated user and company B',
  (select bool_and(rls_test.policy_diff(u) = '') from unnest(array['adm', 'im', 'sales', 'viewer', 'gone', 'b_adm', 'sadm']) u),
  (select string_agg(u || ': ' || rls_test.policy_diff(u), ' | ') from unnest(array['adm', 'im', 'sales', 'viewer', 'gone', 'b_adm', 'sadm']) u where rls_test.policy_diff(u) <> ''));
select rls_test.ok('policy rewrite: the comparison is meaningful (company A has stock movements and audit events to compare)',
  (select count(*) from public.inventory_transactions where company_id = rls_test.id('company_a')) > 0
  and (select count(*) from public.audit_logs where company_id = rls_test.id('company_a')) > 0);
set local role authenticated;

-- ===========================================================================
-- 5. PRIVILEGE ESCALATION AND WORKFLOW BYPASS
-- ===========================================================================
select rls_test.claims('viewer');
select rls_test.expect_blocked('escalation: a viewer cannot grant themselves the ADMIN role',
  format($q$ insert into public.user_roles (user_id, company_id, role_id, assigned_by) values (%L, %L, %L, %L) $q$,
    rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_admin'), rls_test.id('viewer')));
select rls_test.expect_blocked('escalation: a viewer cannot move themselves to another company', format($q$ update public.profiles set company_id = %L where id = %L $q$,
  rls_test.id('company_b'), rls_test.id('viewer')));
select rls_test.expect_blocked('escalation: a viewer cannot edit another user''s profile', format($q$ update public.profiles set full_name = 'x' where id = %L $q$, rls_test.id('adm')));
select rls_test.expect_blocked('escalation: a viewer cannot change company settings', format($q$ update public.companies set gstin = '27AAAAA0000A1Z5' where id = %L $q$, rls_test.id('company_a')));
select rls_test.expect_call_error('escalation: a viewer cannot post stock', format($q$ select public.inventory_post_receipt(%L, %L, 1, 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('pa'), rls_test.id('g1')));
select rls_test.expect_call_error('escalation: a viewer cannot record payments', format($q$ select public.customer_payment_record(%L::jsonb, null, gen_random_uuid()) $q$,
  jsonb_build_object('customer_id', rls_test.id('cu1'), 'amount', 1, 'payment_method', 'UPI')));
select rls_test.claims('gone');
select rls_test.expect_blocked('escalation: a deactivated user cannot reactivate themselves', format($q$ update public.profiles set is_active = true where id = %L $q$, rls_test.id('gone')));
select rls_test.expect_call_error('escalation: a deactivated Sales Manager cannot create orders',
  format($q$ select public.sales_order_create_manual(%L::jsonb, %L::jsonb, false, gen_random_uuid()) $q$,
    jsonb_build_object('customer_id', rls_test.id('cu1')), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('pa'), 'quantity', 1))));
select rls_test.claims('adm');
select rls_test.expect_blocked('escalation: an Admin cannot grant the SUPER_ADMIN role',
  format($q$ insert into public.user_roles (user_id, company_id, role_id, assigned_by) values (%L, %L, %L, %L) $q$,
    rls_test.id('im'), rls_test.id('company_a'), rls_test.id('role_super_admin'), rls_test.id('adm')));
select rls_test.expect_blocked('escalation: an Admin cannot change their own roles',
  format($q$ insert into public.user_roles (user_id, company_id, role_id, assigned_by) values (%L, %L, %L, %L) $q$,
    rls_test.id('adm'), rls_test.id('company_a'), rls_test.id('role_accounts_manager'), rls_test.id('adm')));
select rls_test.expect_blocked('escalation: an Admin cannot remove the Super Admin role',
  format($q$ delete from public.user_roles where user_id = %L $q$, rls_test.id('sadm')));
select rls_test.expect_blocked('escalation: an Admin cannot assign a role in their company to another company''s user',
  format($q$ insert into public.user_roles (user_id, company_id, role_id, assigned_by) values (%L, %L, %L, %L) $q$,
    rls_test.id('b_sales'), rls_test.id('company_a'), rls_test.id('role_admin'), rls_test.id('adm')));
select rls_test.expect_blocked('escalation: an Admin cannot deactivate a Super Admin', format($q$ update public.profiles set is_active = false where id = %L $q$, rls_test.id('sadm')));
select rls_test.expect_blocked('bypass: stock balances cannot be edited directly', format($q$ update public.inventory_balances set on_hand = on_hand + 100 where product_id = %L $q$, rls_test.id('pa')));
select rls_test.expect_blocked('bypass: stock movements cannot be inserted directly',
  format($q$ insert into public.inventory_transactions (company_id, transaction_number, transaction_type, direction, product_id, batch_id, warehouse_id, location_id, quantity, unit,
    source_type, reason, transaction_date) select company_id, 'HACK-1', 'RECEIPT', 1, product_id, batch_id, warehouse_id, location_id, 100, 'PCS', source_type, 'x', now()
    from public.inventory_transactions where product_id = %L limit 1 $q$, rls_test.id('pa')));
select rls_test.expect_blocked('bypass: an issued invoice cannot be edited directly', format($q$ update public.sales_invoices set grand_total = 1 where id = %L $q$, rls_test.gid('inv', 'invoice_id')));
select rls_test.expect_blocked('bypass: an issued invoice cannot be deleted', format($q$ delete from public.sales_invoices where id = %L $q$, rls_test.gid('inv', 'invoice_id')));
select rls_test.expect_blocked('bypass: a receipt amount cannot be edited directly', format($q$ update public.customer_payments set amount_received = 1 where id = %L $q$, rls_test.gid('pay2', 'payment_id')));
select rls_test.expect_blocked('bypass: a sales order cannot be marked delivered directly', format($q$ update public.sales_orders set order_status = 'COMPLETED' where id = %L $q$, rls_test.gid('so', 'sales_order_id')));
select rls_test.expect_blocked('bypass: audit events cannot be inserted by users', format($q$ insert into public.audit_logs (company_id, action, resource_type) values (%L, 'fake.event', 'x') $q$,
  rls_test.id('company_a')));
reset role;
select rls_test.expect_blocked('bypass: even the database owner cannot edit or delete audit events (append-only trigger)', 'update public.audit_logs set action = action');
select rls_test.expect_blocked('bypass: even the database owner cannot delete stock movements (append-only trigger)', 'delete from public.inventory_transactions');
select rls_test.ok('bypass: the escalation attempts changed nothing (roles, Super Admin status, stock, invoice total)',
  (select count(*) from public.user_roles where company_id = rls_test.id('company_a')) = 10
  and (select is_active from public.profiles where id = rls_test.id('sadm')) and not (select is_active from public.profiles where id = rls_test.id('gone'))
  and rls_test.on_hand(rls_test.id('pa')) = 28 and (select grand_total from public.sales_invoices where id = rls_test.gid('inv', 'invoice_id')) = 35400);

-- Static evidence for concurrency (true parallel sessions cannot run in this single-connection harness):
-- every stock / dispatch / invoice / payment / approval writer takes row locks before checking quantities.
select rls_test.ok('concurrency (static): stock postings and payment allocations lock the balance / invoice row before checking it',
  (select bool_and(p.prosrc ~* 'for update') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname in ('post_movement', 'allocate_payment')));
select rls_test.ok('concurrency (static): critical writers lock rows (FOR UPDATE), directly or through those helpers',
  (select bool_and(p.prosrc ~* '(for update|private\.post_movement|private\.allocate_payment)') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('inventory_post_issue', 'inventory_transfer_stock', 'inventory_create_reservation', 'fulfilment_dispatch',
     'sales_invoice_issue', 'customer_payment_allocate', 'customer_payment_record', 'approval_decide', 'sales_order_allocate', 'production_issue_materials')),
  (select string_agg(p.proname, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('inventory_post_issue', 'inventory_transfer_stock', 'inventory_create_reservation', 'fulfilment_dispatch',
     'sales_invoice_issue', 'customer_payment_allocate', 'customer_payment_record', 'approval_decide', 'sales_order_allocate', 'production_issue_materials')
     and p.prosrc !~* '(for update|private\.post_movement|private\.allocate_payment)'));
select rls_test.ok('concurrency (static): document numbers come from locked per-company sequences with unique constraints',
  exists (select 1 from pg_constraint where conname = 'inventory_transactions_number_unique')
  and exists (select 1 from pg_indexes where tablename = 'sales_invoices' and indexdef ilike '%unique%invoice_number%'));

-- ---------------------------------------------------------------------------
-- Result
-- ---------------------------------------------------------------------------
do $$
declare v_passed int; v_failed int; v_detail text;
begin
  select count(*) filter (where passed), count(*) filter (where not passed) into v_passed, v_failed from rls_test.results;
  select string_agg((case when passed then 'PASS ' else 'FAIL ' end) || name || case when not passed and detail is not null then ' -- ' || detail else '' end, E'\n' order by id)
    into v_detail from rls_test.results;
  raise exception 'READINESS_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed using detail = v_detail,
    hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end $$;
