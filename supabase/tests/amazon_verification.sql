-- =============================================================================
-- AMAZON SALES & PROFIT INTELLIGENCE VERIFICATION
--
-- Company isolation and RLS on every Amazon table, permissions, idempotent
-- imports (no duplicate rows), validation, product mapping and the ASIN guard,
-- contribution inputs (ex-GST, cost source), demo / live separation and demo
-- clean-up, the approval-based ad change flow (limits, segregation of duties,
-- stale values, read-only mode, kill switch, connection check, demo refusal,
-- result recorded only from the service role) and that service functions are
-- not callable by browsers.
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction with its own companies (AMA / AMB) and ALWAYS ends by
-- raising AMAZON_VERIFICATION_RESULT passed=N failed=M (rolls everything back).
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
begin perform rls_test.set(p_key, r); perform rls_test.ok(p_name, not (r ? 'error'), left(r::text, 1500)); return r; end $$;
create function rls_test.expect_call_error(p_name text, p_sql text, p_pattern text default null) returns void language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.ok(p_name, r ? 'error' and (p_pattern is null or r ->> 'error' ilike '%' || p_pattern || '%'), left(r::text, 500)); end $$;
create function rls_test.expect_error(p_name text, p_sql text) returns void language plpgsql as $$
begin execute p_sql; perform rls_test.ok(p_name, false, 'statement succeeded but should have been rejected');
exception when others then perform rls_test.ok(p_name, true, format('rejected %s: %s', sqlstate, sqlerrm)); end $$;
create function rls_test.rows(p_sql text) returns int language plpgsql as $$
declare n int; begin execute format('select count(*) from (%s) q', p_sql) into n; return n; end $$;
create function rls_test.claims(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', rls_test.id(p_key), 'role', 'authenticated')::text, true) $$;
create function rls_test.d(p_offset int) returns text language sql stable as $$ select ((now() at time zone 'Asia/Kolkata')::date + p_offset)::text $$;

-- Owner-side probes (bypass RLS to check what is really stored)
create function rls_test.n(p_table text, p_company uuid, p_demo boolean default null) returns int language plpgsql stable security definer as $$
declare v int;
begin
  if p_demo is null then execute format('select count(*)::int from public.%I where company_id = $1', p_table) into v using p_company;
  else execute format('select count(*)::int from public.%I where company_id = $1 and is_demo = $2', p_table) into v using p_company, p_demo;
  end if;
  return v;
end $$;
create function rls_test.erp_rows(p_company uuid) returns int language sql stable security definer as $$
  select ((select count(*) from public.products where company_id = p_company) + (select count(*) from public.inventory_transactions where company_id = p_company)
    + (select count(*) from public.sales_orders where company_id = p_company) + (select count(*) from public.sales_invoices where company_id = p_company))::int $$;
create function rls_test.req(p_id uuid) returns public.amazon_ad_change_requests language sql stable security definer as $$ select * from public.amazon_ad_change_requests where id = p_id $$;
create function rls_test.audit_count(p_company uuid, p_action text) returns int language sql stable security definer as $$
  select count(*)::int from public.audit_logs where company_id = p_company and action = p_action $$;
create function rls_test.notes(p_user uuid, p_type text) returns int language sql stable security definer as $$
  select count(*)::int from public.notifications where recipient_user_id = p_user and notification_type = p_type $$;
create function rls_test.bid(p_company uuid, p_target text) returns numeric language sql stable security definer as $$
  select bid from public.amazon_targets where company_id = p_company and target_id = p_target $$;
create function rls_test.budget(p_company uuid, p_campaign text) returns numeric language sql stable security definer as $$
  select daily_budget from public.amazon_campaigns where company_id = p_company and campaign_id = p_campaign $$;
grant execute on all functions in schema rls_test to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'a3a20000-0000-4000-8000-0000000000a1'), ('company_b', 'a3a20000-0000-4000-8000-0000000000b1'),
  ('adm', 'a3a20000-0000-4000-8000-000000000001'), ('adm2', 'a3a20000-0000-4000-8000-000000000002'), ('sales', 'a3a20000-0000-4000-8000-000000000003'),
  ('viewer', 'a3a20000-0000-4000-8000-000000000004'), ('im', 'a3a20000-0000-4000-8000-000000000005'), ('b_adm', 'a3a20000-0000-4000-8000-000000000006'),
  ('p1', 'a3a20000-0000-4000-8000-0000000000c1'), ('p2', 'a3a20000-0000-4000-8000-0000000000c2'), ('p_b', 'a3a20000-0000-4000-8000-0000000000c3');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code) values
  (rls_test.id('company_a'), 'Amazon Test A Pvt Ltd', 'Amazon A', 'AMA'), (rls_test.id('company_b'), 'Amazon Test B', 'Amazon B', 'AMB');
insert into auth.users (id, email) select id, key || '@amz.example.invalid' from rls_test.ids where key in ('adm', 'adm2', 'sales', 'viewer', 'im', 'b_adm');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id in (select id from rls_test.ids where key in ('adm', 'adm2', 'sales', 'viewer', 'im'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_adm');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('adm'), rls_test.id('company_a'), rls_test.id('role_admin')), (rls_test.id('adm2'), rls_test.id('company_a'), rls_test.id('role_admin')),
  (rls_test.id('sales'), rls_test.id('company_a'), rls_test.id('role_sales_manager')), (rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_management_viewer')),
  (rls_test.id('im'), rls_test.id('company_a'), rls_test.id('role_inventory_manager')), (rls_test.id('b_adm'), rls_test.id('company_b'), rls_test.id('role_admin'));
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, standard_cost, gst_rate, status) values
  (rls_test.id('p1'), rls_test.id('company_a'), 'AM-BASIN', 'Wash Basin', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 1000, 18, 'ACTIVE'),
  (rls_test.id('p2'), rls_test.id('company_a'), 'AM-TAP', 'Tap', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', null, null, 'ACTIVE'),
  (rls_test.id('p_b'), rls_test.id('company_b'), 'AM-BASIN', 'Basin B', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 900, 18, 'ACTIVE');
select rls_test.set('erp_before', to_jsonb(rls_test.erp_rows(rls_test.id('company_a'))));

-- ---------------------------------------------------------------------------
-- Schema, grants and defaults
-- ---------------------------------------------------------------------------
select rls_test.ok('RLS is enabled on every Amazon table',
  not exists (select 1 from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind = 'r' and c.relname like 'amazon\_%' and not c.relrowsecurity)
  and (select count(*) from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind = 'r' and c.relname like 'amazon\_%') >= 15);
select rls_test.ok('browsers cannot write Amazon tables directly, and anon cannot read them',
  not exists (select 1 from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind = 'r' and c.relname like 'amazon\_%'
    and (has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE') or has_table_privilege('anon', c.oid, 'SELECT'))));
select rls_test.ok('service functions (ingest, job, connection, change claim / result) are not executable by browsers',
  not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like 'amazon\_service\_%'
    and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE')))
  and (select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like 'amazon\_service\_%') = 7);
select rls_test.ok('no Amazon function is executable by anon',
  not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like 'amazon\_%' and has_function_privilege('anon', p.oid, 'EXECUTE')));
select rls_test.ok('no credential columns exist in Amazon tables (secrets live only in Edge Function secrets)',
  not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name like 'amazon\_%'
    and column_name ~* '(secret|refresh_token|access_token|client_id|password)'));
select rls_test.ok('a new company gets safe defaults: read-only automation and kill switch ON',
  (select automation_mode = 'READ_ONLY' and kill_switch from public.amazon_settings where company_id = rls_test.id('company_a')));
select rls_test.ok('a new company has both API connections as NOT_CONFIGURED (never shown as connected)',
  (select count(*) = 2 and bool_and(status = 'NOT_CONFIGURED') from public.amazon_connections where company_id = rls_test.id('company_a')));
select rls_test.ok('role grants: sales manager has read / manage / request but not approve; viewer and inventory are read-only',
  exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = rls_test.id('role_sales_manager') and p.code = 'amazon_ads.request')
  and not exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = rls_test.id('role_sales_manager') and p.code in ('amazon_ads.approve', 'amazon_integration.manage'))
  and not exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = rls_test.id('role_management_viewer') and p.code <> 'amazon.read' and p.code like 'amazon%')
  and exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = rls_test.id('role_admin') and p.code = 'amazon_ads.approve'));

set local role authenticated;

-- ---------------------------------------------------------------------------
-- Imports: validation and idempotency
-- ---------------------------------------------------------------------------
select rls_test.claims('viewer');
select rls_test.expect_call_error('permissions: a read-only user cannot import Amazon data',
  $q$ select public.amazon_import_rows('LISTINGS', '[{"seller_sku":"X"}]', 'x.csv', gen_random_uuid()) $q$);
select rls_test.ok('permissions: a read-only user can read the Amazon settings', rls_test.rows('select 1 from public.amazon_settings') = 1);

select rls_test.claims('sales');
select rls_test.set('k1', to_jsonb(gen_random_uuid()));
select rls_test.expect_call_ok('import: listings file accepted', 'imp_l', format($q$ select public.amazon_import_rows('LISTINGS',
  '[{"seller_sku":"AM-BASIN","asin":"B0TEST0001","title":"Basin","item_price":2360,"fulfillment_channel":"MFN"},
    {"seller_sku":"AM-TAP","asin":"B0TEST0002","title":"Tap","item_price":590},
    {"seller_sku":"BAD","asin":"bad-asin"}]', 'listings.csv', %L) $q$, rls_test.get('k1') #>> '{}'));
select rls_test.ok('import: valid rows inserted, an invalid ASIN skipped with a row-numbered error',
  (rls_test.get('imp_l') ->> 'inserted')::int = 2 and (rls_test.get('imp_l') ->> 'skipped')::int = 1 and rls_test.get('imp_l') #>> '{errors,0,row}' = '3', rls_test.get('imp_l')::text);
select rls_test.expect_call_ok('import: the same request id again', 'imp_l2', format($q$ select public.amazon_import_rows('LISTINGS',
  '[{"seller_sku":"AM-BASIN","asin":"B0TEST0001"}]', 'listings.csv', %L) $q$, rls_test.get('k1') #>> '{}'));
select rls_test.ok('import: a retried request is recognised as a duplicate and writes nothing',
  (rls_test.get('imp_l2') ->> 'duplicate')::boolean and rls_test.n('amazon_listings', rls_test.id('company_a')) = 2 and rls_test.n('amazon_sync_jobs', rls_test.id('company_a')) = 1);

select rls_test.set('sales_rows', format('[{"seller_sku":"AM-BASIN","metric_date":"%s","ordered_sales":2360,"units_ordered":1,"total_order_items":1,"sessions":40},
  {"seller_sku":"AM-BASIN","metric_date":"%s","ordered_sales":4720,"units_ordered":2,"total_order_items":2,"sessions":50},
  {"seller_sku":"AM-BASIN","metric_date":"%s","ordered_sales":4720,"units_ordered":2,"total_order_items":2,"sessions":50},
  {"seller_sku":"AM-BASIN","metric_date":"not-a-date","ordered_sales":1},
  {"seller_sku":"AM-BASIN","metric_date":"%s","ordered_sales":1},
  {"seller_sku":"AM-TAP","metric_date":"%s","ordered_sales":"-5x"}]', rls_test.d(-3), rls_test.d(-2), rls_test.d(-2), rls_test.d(10), rls_test.d(-2))::jsonb);
select rls_test.expect_call_ok('import: daily sales', 'imp_s', format($q$ select public.amazon_import_rows('SKU_SALES', %L, 'business.csv', gen_random_uuid()) $q$, rls_test.get('sales_rows')));
select rls_test.ok('import: duplicate rows in one file are de-duplicated; invalid dates, future dates and bad numbers are rejected',
  (rls_test.get('imp_s') ->> 'inserted')::int = 2 and (rls_test.get('imp_s') ->> 'skipped')::int = 4
  and (select count(*) from jsonb_array_elements(rls_test.get('imp_s') -> 'errors') e where e ->> 'message' ilike '%future%') = 1, rls_test.get('imp_s')::text);
select rls_test.expect_call_ok('import: the same data under a new request id', 'imp_s2', format($q$ select public.amazon_import_rows('SKU_SALES', %L, 'business.csv', gen_random_uuid()) $q$, rls_test.get('sales_rows')));
select rls_test.ok('import: re-importing updates rows in place, never duplicates them',
  (rls_test.get('imp_s2') ->> 'inserted')::int = 0 and (rls_test.get('imp_s2') ->> 'updated')::int = 2 and rls_test.n('amazon_sku_daily', rls_test.id('company_a')) = 2);
select rls_test.expect_call_ok('import: settlement fees for one day', 'imp_f', format($q$ select public.amazon_import_rows('SKU_FEES',
  '[{"seller_sku":"AM-BASIN","metric_date":"%s","referral_fees":200,"fulfilment_fees":100,"other_fees":0}]', 'fees.csv', gen_random_uuid()) $q$, rls_test.d(-3)));
select rls_test.ok('import: fees merge into the same day row without touching its sales', rls_test.n('amazon_sku_daily', rls_test.id('company_a')) = 2
  and (select ordered_sales = 2360 and referral_fees = 200 from public.amazon_sku_daily where seller_sku = 'AM-BASIN' and metric_date = rls_test.d(-3)::date));
select rls_test.ok('import: imported rows are marked as CSV live data with their job', not exists (select 1 from public.amazon_sku_daily where data_source <> 'CSV' or is_demo or sync_job_id is null));
select rls_test.ok('import: Amazon data never writes ERP products, stock, orders or invoices', rls_test.erp_rows(rls_test.id('company_a')) = (rls_test.get('erp_before') #>> '{}')::int);

-- ---------------------------------------------------------------------------
-- Mapping and contribution inputs
-- ---------------------------------------------------------------------------
select rls_test.expect_call_ok('mapping: auto-map by exact SKU', 'map', $q$ select public.amazon_listing_auto_map() $q$);
select rls_test.ok('mapping: both listings mapped to their ERP products', (rls_test.get('map') ->> 'mapped')::int = 2
  and (select product_id from public.amazon_listings where seller_sku = 'AM-BASIN') = rls_test.id('p1'));
select rls_test.expect_call_error('mapping: one ASIN cannot be mapped to two different ERP products',
  format($q$ select public.amazon_listing_save(jsonb_build_object('seller_sku', 'AM-BASIN-FBA', 'asin', 'B0TEST0001', 'product_id', %L)) $q$, rls_test.id('p2')), 'already mapped');
select rls_test.expect_call_error('mapping: a product of another company cannot be mapped',
  format($q$ select public.amazon_listing_save(jsonb_build_object('id', (select id from public.amazon_listings where seller_sku = 'AM-TAP'), 'product_id', %L)) $q$, rls_test.id('p_b')), 'not found');
select rls_test.expect_call_ok('mapping: listing fee estimates and lead time saved', 'ls', $q$ select public.amazon_listing_save(jsonb_build_object('id', (select id from public.amazon_listings where seller_sku = 'AM-BASIN'),
  'referral_fee_pct', 10, 'fulfilment_fee_per_unit', 50, 'lead_time_days', 21)) $q$);
select rls_test.ok('mapping: cost changes are time-stamped and audited', (select costs_updated_at is not null from public.amazon_listings where seller_sku = 'AM-BASIN')
  and rls_test.audit_count(rls_test.id('company_a'), 'amazon.listing_updated') >= 1);

select rls_test.expect_call_ok('analytics: product performance for the live data', 'pp', format($q$ select public.amazon_product_performance(%L, %L, false) $q$, rls_test.d(-7), rls_test.d(0)));
select rls_test.set('basin', (select r from jsonb_array_elements(rls_test.get('pp') -> 'rows') r where r ->> 'seller_sku' = 'AM-BASIN'));
select rls_test.ok('analytics: sales are converted to ex-GST with the ERP product GST rate (7080 incl. 18% = 6000)',
  round((rls_test.get('basin') #>> '{totals,sales_ex_gst}')::numeric) = 6000 and rls_test.get('basin') ->> 'gst_source' = 'ERP_PRODUCT', rls_test.get('basin')::text);
select rls_test.ok('analytics: product cost comes from the ERP standard cost (3 units x 1000) and says so',
  (rls_test.get('basin') #>> '{totals,product_cost}')::numeric = 3000 and rls_test.get('basin') ->> 'cost_source' = 'ERP_STANDARD_COST');
select rls_test.ok('analytics: actual settlement fees used where present, estimates only for days without them',
  (rls_test.get('basin') #>> '{totals,actual_referral}')::numeric = 200 and (rls_test.get('basin') #>> '{totals,est_referral}')::numeric = 472, rls_test.get('basin')::text);
select rls_test.ok('analytics: a product without cost or GST reports them as missing, not zero',
  (select r ->> 'cost_source' = 'MISSING' and r ->> 'gst_source' = 'MISSING' from jsonb_array_elements(rls_test.get('pp') -> 'rows') r where r ->> 'seller_sku' = 'AM-TAP'));
select rls_test.expect_call_error('analytics: inverted date ranges are rejected', format($q$ select public.amazon_product_performance(%L, %L, false) $q$, rls_test.d(0), rls_test.d(-7)));

-- ---------------------------------------------------------------------------
-- Company isolation
-- ---------------------------------------------------------------------------
select rls_test.claims('b_adm');
select rls_test.ok('isolation: another company sees none of company A''s listings, sales, jobs or settings',
  rls_test.rows('select 1 from public.amazon_listings') = 0 and rls_test.rows('select 1 from public.amazon_sku_daily') = 0
  and rls_test.rows('select 1 from public.amazon_sync_jobs') = 0 and rls_test.rows($s$ select 1 from public.amazon_settings where company_id <> (select company_id from public.profiles where id = auth.uid()) $s$) = 0);
select rls_test.ok('isolation: another company''s analytics contain none of company A''s data',
  jsonb_array_length(public.amazon_product_performance(rls_test.d(-7)::date, rls_test.d(0)::date, false) -> 'rows') = 0);
reset role;
select rls_test.set('a_listing', to_jsonb((select id from public.amazon_listings where company_id = rls_test.id('company_a') and seller_sku = 'AM-TAP')));
set local role authenticated;
select rls_test.claims('b_adm');
select rls_test.expect_call_error('isolation: another company cannot edit company A''s listing by id',
  format($q$ select public.amazon_listing_save(jsonb_build_object('id', %L, 'unit_cost_override', 1)) $q$, rls_test.get('a_listing') #>> '{}'), 'not found');

-- ---------------------------------------------------------------------------
-- Demo data: separate, labelled, removable
-- ---------------------------------------------------------------------------
select rls_test.claims('viewer');
select rls_test.expect_call_error('demo: a read-only user cannot load demo data', $q$ select public.amazon_demo_load(30) $q$);
select rls_test.claims('sales');
select rls_test.set('live_listings', to_jsonb(rls_test.n('amazon_listings', rls_test.id('company_a'), false)));
select rls_test.set('live_daily', to_jsonb(rls_test.n('amazon_sku_daily', rls_test.id('company_a'), false)));
select rls_test.expect_call_ok('demo: load 30 days of demo data', 'demo', $q$ select public.amazon_demo_load(30) $q$);
select rls_test.ok('demo: demo rows are flagged and sourced DEMO, and demo listings are never mapped to ERP products',
  rls_test.n('amazon_listings', rls_test.id('company_a'), true) = 8 and rls_test.n('amazon_sku_daily', rls_test.id('company_a'), true) > 0
  and not exists (select 1 from public.amazon_listings where is_demo and (product_id is not null or data_source <> 'DEMO'))
  and not exists (select 1 from public.amazon_sku_daily where is_demo and data_source <> 'DEMO'));
select rls_test.ok('demo: live data is unchanged by loading demo data',
  rls_test.n('amazon_listings', rls_test.id('company_a'), false) = (rls_test.get('live_listings') #>> '{}')::int
  and rls_test.n('amazon_sku_daily', rls_test.id('company_a'), false) = (rls_test.get('live_daily') #>> '{}')::int);
select rls_test.ok('demo: live analytics never include demo rows',
  (select count(*) from jsonb_array_elements(public.amazon_product_performance(rls_test.d(-7)::date, rls_test.d(0)::date, false) -> 'rows') r where r ->> 'seller_sku' like 'DEMO-%') = 0);
select rls_test.ok('demo: demo analytics contain only demo products',
  (select count(*) = 8 and bool_and(r ->> 'seller_sku' like 'DEMO-%') from jsonb_array_elements(public.amazon_product_performance(rls_test.d(-14)::date, rls_test.d(0)::date, true) -> 'rows') r));
select rls_test.ok('demo: demo data never writes ERP products, stock, orders or invoices', rls_test.erp_rows(rls_test.id('company_a')) = (rls_test.get('erp_before') #>> '{}')::int);
select rls_test.expect_call_error('demo: a demo listing cannot be mapped to a real ERP product',
  format($q$ select public.amazon_listing_save(jsonb_build_object('id', (select id from public.amazon_listings where is_demo limit 1), 'product_id', %L)) $q$, rls_test.id('p2')), 'demo');
select rls_test.expect_call_ok('demo: reloading demo data', 'demo2', $q$ select public.amazon_demo_load(30) $q$);
select rls_test.ok('demo: reloading replaces instead of duplicating', rls_test.n('amazon_listings', rls_test.id('company_a'), true) = 8);

-- ---------------------------------------------------------------------------
-- Recommendations and budget plans
-- ---------------------------------------------------------------------------
select rls_test.expect_call_ok('recommendations: saving engine output', 'rec', format($q$ select public.amazon_recommendations_save(jsonb_build_array(jsonb_build_object(
  'rule_code', 'MISSING_COST_DATA', 'entity_type', 'PRODUCT', 'entity_key', 'AM-TAP', 'entity_label', 'Tap', 'period_from', %L, 'period_to', %L, 'title', 'Complete cost data',
  'issue', 'No cost', 'proposed_action', 'Enter the cost', 'evidence', '{}'::jsonb, 'financial', jsonb_build_object('calculation', 'n/a', 'change', null), 'impact_direction', 'IMPROVE_DATA',
  'confidence', 'HIGH', 'missing_info', '["product cost"]'::jsonb, 'priority', 50)), false) $q$, rls_test.d(-7), rls_test.d(0)));
select rls_test.expect_call_ok('recommendations: saving the same recommendation again', 'rec2', format($q$ select public.amazon_recommendations_save(jsonb_build_array(jsonb_build_object(
  'rule_code', 'MISSING_COST_DATA', 'entity_type', 'PRODUCT', 'entity_key', 'AM-TAP', 'entity_label', 'Tap', 'period_from', %L, 'period_to', %L, 'title', 'Complete cost data',
  'issue', 'No cost', 'proposed_action', 'Enter the cost', 'impact_direction', 'IMPROVE_DATA', 'confidence', 'HIGH', 'priority', 50)), false) $q$, rls_test.d(-7), rls_test.d(0)));
select rls_test.ok('recommendations: one row per rule, entity and period (no duplicates)', rls_test.n('amazon_recommendations', rls_test.id('company_a'), false) = 1);
select rls_test.expect_call_error('recommendations: dismissing needs a reason',
  $q$ select public.amazon_recommendation_set_status((select id from public.amazon_recommendations limit 1), 'DISMISSED', '') $q$, 'reason');
select rls_test.expect_call_ok('budget: a plan is saved as a planning record', 'plan', format($q$ select public.amazon_budget_plan_save('Test plan', %L, '{"total_budget": 30000}', '{"items": []}', array['diminishing returns'], false) $q$, rls_test.d(0)));
select rls_test.claims('viewer');
select rls_test.expect_call_error('budget: a read-only user cannot save plans', format($q$ select public.amazon_budget_plan_save('Viewer plan', %L, '{}', '{}', null, false) $q$, rls_test.d(0)));

-- ---------------------------------------------------------------------------
-- Approval-based advertising changes
-- ---------------------------------------------------------------------------
select rls_test.claims('sales');
select rls_test.expect_call_ok('ads: campaigns, ad groups and targets imported', 'camp', $q$ select public.amazon_import_rows('CAMPAIGNS',
  '[{"profile_id":"P1","campaign_id":"111","name":"Basins - exact","state":"ENABLED","daily_budget":1000},{"profile_id":"P1","campaign_id":"222","name":"Taps - auto","state":"ENABLED","daily_budget":500}]',
  'campaigns.csv', gen_random_uuid()) $q$);
select rls_test.expect_call_ok('ads: targets imported', 'tgt', $q$ select public.amazon_import_rows('TARGETS',
  '[{"profile_id":"P1","campaign_id":"111","ad_group_id":"AG1","target_id":"T1","expression":"wash basin","match_type":"EXACT","bid":10}]', 'targets.csv', gen_random_uuid()) $q$);

select rls_test.claims('im');
select rls_test.expect_call_error('ads: a user without amazon_ads.request cannot propose changes',
  $q$ select public.amazon_ad_change_request('{"change_type":"CAMPAIGN_BUDGET","campaign_id":"111","daily_budget":1100,"reason":"more budget"}') $q$);
select rls_test.claims('sales');
select rls_test.expect_call_error('ads: a budget change above the per-change limit (30%) is refused',
  $q$ select public.amazon_ad_change_request('{"change_type":"CAMPAIGN_BUDGET","campaign_id":"111","daily_budget":2000,"reason":"double it"}') $q$, 'allowed');
select rls_test.expect_call_error('ads: a request needs a reason',
  $q$ select public.amazon_ad_change_request('{"change_type":"CAMPAIGN_BUDGET","campaign_id":"111","daily_budget":1100,"reason":""}') $q$);
select rls_test.expect_call_ok('ads: a budget change within limits is requested', 'r_budget',
  $q$ select public.amazon_ad_change_request('{"change_type":"CAMPAIGN_BUDGET","campaign_id":"111","daily_budget":1100,"reason":"Profitable and budget-limited"}') $q$);
select rls_test.ok('ads: the request stores the server-side current value, the proposal and rollback instructions, and is pending',
  (select status = 'PENDING_APPROVAL' and (old_value ->> 'daily_budget')::numeric = 1000 and (proposed_value ->> 'daily_budget')::numeric = 1100 and rollback_instructions like '%1000%'
     and requested_by = rls_test.id('sales') and not is_demo from rls_test.req((rls_test.get('r_budget') ->> 'id')::uuid)));
select rls_test.ok('ads: approvers are notified of the pending request', rls_test.notes(rls_test.id('adm'), 'APPROVAL_REQUESTED') >= 1);
select rls_test.expect_call_error('ads: a second open request for the same item is refused',
  $q$ select public.amazon_ad_change_request('{"change_type":"CAMPAIGN_BUDGET","campaign_id":"111","daily_budget":1050,"reason":"another one"}') $q$, 'already exists');
select rls_test.expect_call_error('ads: the requester (without approve permission) cannot approve',
  format($q$ select public.amazon_ad_change_decide(%L, 'APPROVE') $q$, rls_test.get('r_budget') ->> 'id'));
select rls_test.expect_call_error('ads: the analysis-only role cannot change automation limits or the kill switch', $q$ select public.amazon_settings_update('{"kill_switch": false}') $q$, 'approve');

select rls_test.claims('adm');
select rls_test.expect_call_ok('ads: an approver sets a maximum bid', 'lim', $q$ select public.amazon_settings_update('{"max_bid": 12}') $q$);
select rls_test.expect_call_error('ads: a bid above the maximum bid is refused',
  $q$ select public.amazon_ad_change_request('{"change_type":"TARGET_BID","campaign_id":"111","target_id":"T1","bid":12.5,"reason":"raise bid"}') $q$, 'maximum bid');
select rls_test.expect_call_ok('ads: the approver proposes a bid change', 'r_bid',
  $q$ select public.amazon_ad_change_request('{"change_type":"TARGET_BID","campaign_id":"111","target_id":"T1","bid":11,"reason":"Below target ACoS"}') $q$);
select rls_test.expect_call_error('ads: segregation of duties - nobody approves their own request',
  format($q$ select public.amazon_ad_change_decide(%L, 'APPROVE') $q$, rls_test.get('r_bid') ->> 'id'), 'own');
select rls_test.claims('adm2');
select rls_test.expect_call_ok('ads: a second approver approves the bid change', 'd_bid', format($q$ select public.amazon_ad_change_decide(%L, 'APPROVE', 'ok') $q$, rls_test.get('r_bid') ->> 'id'));
select rls_test.expect_call_ok('ads: a second approver approves the budget change', 'd_budget', format($q$ select public.amazon_ad_change_decide(%L, 'APPROVE') $q$, rls_test.get('r_budget') ->> 'id'));
select rls_test.ok('ads: approval does not change anything locally or on Amazon',
  rls_test.bid(rls_test.id('company_a'), 'T1') = 10 and rls_test.budget(rls_test.id('company_a'), '111') = 1000
  and (rls_test.req((rls_test.get('r_bid') ->> 'id')::uuid)).status = 'APPROVED' and (rls_test.req((rls_test.get('r_bid') ->> 'id')::uuid)).executed_at is null);

select rls_test.claims('sales');
select rls_test.expect_call_ok('ads: a pause request', 'r_state', $q$ select public.amazon_ad_change_request('{"change_type":"CAMPAIGN_STATE","campaign_id":"222","state":"PAUSED","reason":"Loss-making"}') $q$);
reset role;
update public.amazon_campaigns set state = 'PAUSED' where company_id = rls_test.id('company_a') and campaign_id = '222';
set local role authenticated;
select rls_test.claims('adm');
select rls_test.expect_call_ok('ads: approving after the value changed on Amazon', 'd_state', format($q$ select public.amazon_ad_change_decide(%L, 'APPROVE') $q$, rls_test.get('r_state') ->> 'id'));
select rls_test.ok('ads: a stale request is cancelled at approval, never approved', (rls_test.get('d_state') ->> 'stale')::boolean
  and (rls_test.req((rls_test.get('r_state') ->> 'id')::uuid)).status = 'CANCELLED');

-- Execution gates (service role = the amazon-ads Edge Function after it authenticated the approver)
reset role;
set local role service_role;
select rls_test.set('c1', public.amazon_service_change_claim(rls_test.id('company_a'), (rls_test.get('r_bid') ->> 'id')::uuid, rls_test.id('adm2')));
select rls_test.ok('execute: refused while automation is READ-ONLY', not (rls_test.get('c1') ->> 'ok')::boolean and rls_test.get('c1') ->> 'reason' ilike '%read-only%', rls_test.get('c1')::text);
reset role;
set local role authenticated;
select rls_test.claims('adm');
select rls_test.expect_call_ok('execute: an approver switches to approval-required mode', 'mode', $q$ select public.amazon_settings_update('{"automation_mode": "APPROVAL_REQUIRED"}') $q$);
reset role;
set local role service_role;
select rls_test.set('c2', public.amazon_service_change_claim(rls_test.id('company_a'), (rls_test.get('r_bid') ->> 'id')::uuid, rls_test.id('adm2')));
select rls_test.ok('execute: refused while the kill switch is ON', not (rls_test.get('c2') ->> 'ok')::boolean and rls_test.get('c2') ->> 'reason' ilike '%kill switch%', rls_test.get('c2')::text);
reset role;
set local role authenticated;
select rls_test.claims('adm');
select rls_test.expect_call_ok('execute: an approver turns the kill switch off', 'ks', $q$ select public.amazon_settings_update('{"kill_switch": false}') $q$);
select rls_test.ok('execute: kill switch changes are audited', rls_test.audit_count(rls_test.id('company_a'), 'amazon.kill_switch_off') = 1);
reset role;
set local role service_role;
select rls_test.set('c3', public.amazon_service_change_claim(rls_test.id('company_a'), (rls_test.get('r_bid') ->> 'id')::uuid, rls_test.id('adm2')));
select rls_test.ok('execute: refused while the Ads API is not connected', not (rls_test.get('c3') ->> 'ok')::boolean and rls_test.get('c3') ->> 'reason' ilike '%not connected%', rls_test.get('c3')::text);
select public.amazon_service_connection_update(rls_test.id('company_a'), 'ADS_API', '{"status": "CONNECTED", "profile_id": "P1", "last_test_ok": true, "last_test_message": "Connected (test)"}');
select rls_test.set('c4', public.amazon_service_change_claim(rls_test.id('company_a'), (rls_test.get('r_bid') ->> 'id')::uuid, rls_test.id('adm2')));
select rls_test.ok('execute: claimed once all gates pass; status EXECUTING, not yet succeeded', (rls_test.get('c4') ->> 'ok')::boolean
  and (rls_test.req((rls_test.get('r_bid') ->> 'id')::uuid)).status = 'EXECUTING' and rls_test.bid(rls_test.id('company_a'), 'T1') = 10, rls_test.get('c4')::text);
select rls_test.set('c5', public.amazon_service_change_claim(rls_test.id('company_a'), (rls_test.get('r_bid') ->> 'id')::uuid, rls_test.id('adm2')));
select rls_test.ok('execute: a request cannot be claimed twice', not (rls_test.get('c5') ->> 'ok')::boolean);
select public.amazon_service_change_result(rls_test.id('company_a'), (rls_test.get('r_bid') ->> 'id')::uuid, true, 'amzn-req-123', '{"success": true}', null);
select rls_test.ok('execute: only an API-confirmed result marks success, with the Amazon request id; the new bid is recorded',
  (rls_test.req((rls_test.get('r_bid') ->> 'id')::uuid)).status = 'SUCCEEDED' and (rls_test.req((rls_test.get('r_bid') ->> 'id')::uuid)).api_request_id = 'amzn-req-123'
  and rls_test.bid(rls_test.id('company_a'), 'T1') = 11 and rls_test.audit_count(rls_test.id('company_a'), 'amazon.ad_change_executed') = 1
  and rls_test.notes(rls_test.id('adm'), 'AMAZON_AD_CHANGE_RESULT') = 1);
select rls_test.set('c6', public.amazon_service_change_claim(rls_test.id('company_a'), (rls_test.get('r_budget') ->> 'id')::uuid, rls_test.id('adm2')));
select public.amazon_service_change_result(rls_test.id('company_a'), (rls_test.get('r_budget') ->> 'id')::uuid, false, null, null, 'HTTP 400 invalid budget');
select rls_test.ok('execute: a failed API call is recorded as FAILED and the budget is left unchanged',
  (rls_test.get('c6') ->> 'ok')::boolean and (rls_test.req((rls_test.get('r_budget') ->> 'id')::uuid)).status = 'FAILED'
  and rls_test.budget(rls_test.id('company_a'), '111') = 1000 and (rls_test.req((rls_test.get('r_budget') ->> 'id')::uuid)).error_message like '%invalid budget%');
reset role;
set local role authenticated;

select rls_test.claims('sales');
select rls_test.expect_call_ok('ads: a change request on a demo campaign', 'r_demo',
  $q$ select public.amazon_ad_change_request(jsonb_build_object('change_type', 'CAMPAIGN_STATE', 'campaign_id', (select campaign_id from public.amazon_campaigns where is_demo and state = 'ENABLED' limit 1),
    'state', 'PAUSED', 'reason', 'demo pause')) $q$);
select rls_test.claims('adm');
select rls_test.expect_call_ok('ads: the demo request is approved', 'd_demo', format($q$ select public.amazon_ad_change_decide(%L, 'APPROVE') $q$, rls_test.get('r_demo') ->> 'id'));
reset role;
set local role service_role;
select rls_test.set('c7', public.amazon_service_change_claim(rls_test.id('company_a'), (rls_test.get('r_demo') ->> 'id')::uuid, rls_test.id('adm')));
select rls_test.ok('execute: demo changes are never sent to Amazon', not (rls_test.get('c7') ->> 'ok')::boolean and rls_test.get('c7') ->> 'reason' ilike '%demo%', rls_test.get('c7')::text);
reset role;
set local role authenticated;

select rls_test.claims('adm');
select rls_test.expect_error('ads: browsers cannot record an execution result themselves',
  format($q$ select public.amazon_service_change_result(%L, %L, true, 'fake', null, null) $q$, rls_test.id('company_a'), rls_test.get('r_demo') ->> 'id'));
select rls_test.expect_error('ads: browsers cannot ingest data as the API',
  format($q$ select public.amazon_service_ingest(%L, gen_random_uuid(), 'LISTINGS', '[]') $q$, rls_test.id('company_a')));
select rls_test.expect_error('ads: browsers cannot mark a connection as connected',
  format($q$ select public.amazon_service_connection_update(%L, 'SP_API', '{"status":"CONNECTED"}') $q$, rls_test.id('company_a')));
select rls_test.claims('b_adm');
select rls_test.ok('isolation: another company sees none of company A''s campaigns, change requests, recommendations or plans',
  rls_test.rows('select 1 from public.amazon_campaigns') = 0 and rls_test.rows('select 1 from public.amazon_ad_change_requests') = 0
  and rls_test.rows('select 1 from public.amazon_recommendations') = 0 and rls_test.rows('select 1 from public.amazon_budget_plans') = 0);
select rls_test.expect_call_error('isolation: another company cannot approve company A''s change request',
  format($q$ select public.amazon_ad_change_decide(%L, 'REJECT', 'not mine') $q$, rls_test.get('r_demo') ->> 'id'), 'not found');

-- ---------------------------------------------------------------------------
-- Demo clean-up touches only demo rows
-- ---------------------------------------------------------------------------
select rls_test.claims('sales');
select rls_test.set('live_campaigns', to_jsonb(rls_test.n('amazon_campaigns', rls_test.id('company_a'), false)));
select rls_test.set('live_requests', to_jsonb(rls_test.n('amazon_ad_change_requests', rls_test.id('company_a'), false)));
select rls_test.expect_call_ok('demo: clear demo data', 'clear', $q$ select public.amazon_demo_clear() $q$);
select rls_test.ok('demo: every demo row is removed', (select bool_and(rls_test.n(t, rls_test.id('company_a'), true) = 0) from unnest(array['amazon_listings', 'amazon_sku_daily',
  'amazon_inventory_snapshots', 'amazon_campaigns', 'amazon_ad_groups', 'amazon_targets', 'amazon_campaign_daily', 'amazon_ad_product_daily', 'amazon_search_term_daily',
  'amazon_recommendations', 'amazon_budget_plans', 'amazon_ad_change_requests']) t));
select rls_test.ok('demo: live listings, sales, campaigns and change requests are untouched by the clean-up',
  rls_test.n('amazon_listings', rls_test.id('company_a'), false) = (rls_test.get('live_listings') #>> '{}')::int
  and rls_test.n('amazon_sku_daily', rls_test.id('company_a'), false) = (rls_test.get('live_daily') #>> '{}')::int
  and rls_test.n('amazon_campaigns', rls_test.id('company_a'), false) = (rls_test.get('live_campaigns') #>> '{}')::int
  and rls_test.n('amazon_ad_change_requests', rls_test.id('company_a'), false) = (rls_test.get('live_requests') #>> '{}')::int
  and rls_test.n('amazon_recommendations', rls_test.id('company_a'), false) = 1);
select rls_test.ok('audit: imports, mapping, demo load / clear and ad changes are all audited',
  rls_test.audit_count(rls_test.id('company_a'), 'amazon.import') >= 5 and rls_test.audit_count(rls_test.id('company_a'), 'amazon.listing_auto_mapped') = 1
  and rls_test.audit_count(rls_test.id('company_a'), 'amazon.ad_change_requested') >= 3 and rls_test.audit_count(rls_test.id('company_a'), 'amazon.ad_change_approved') >= 2
  and rls_test.audit_count(rls_test.id('company_a'), 'amazon.ad_change_failed') = 1);

reset role;
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
  raise exception 'AMAZON_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
