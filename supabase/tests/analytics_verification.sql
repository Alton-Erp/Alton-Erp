-- =============================================================================
-- EXECUTIVE DASHBOARD & BUSINESS ANALYTICS (PHASE 9) VERIFICATION
--
-- Builds real records through the Phase 4-8 functions (receipts, transfer,
-- quarantine stock, sales orders, allocation, partial dispatches, invoices,
-- a draft invoice, a partial payment, a credit note, a production order with
-- output, a pending adjustment), then checks every analytics figure against
-- the known source values: KPI totals, date filters, current vs historical
-- stock, transfers, reservations, source split, planned vs completed
-- production, partial dispatch, draft exclusion, collections, allocations,
-- notes, as-of overdue, missing cost data, drill-down sources, pagination,
-- alerts, data quality, permissions, cross-company isolation and that the
-- analytics functions change nothing.
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction with its own companies (ANA / ANB) and ALWAYS ends by
-- raising ANALYTICS_VERIFICATION_RESULT passed=N failed=M (rolls everything back).
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
begin perform rls_test.set(p_key, r); perform rls_test.ok(p_name, not (r ? 'error'), left(r::text, 2000)); return r; end $$;
create function rls_test.expect_call_error(p_name text, p_sql text, p_pattern text default null) returns void language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.ok(p_name, r ? 'error' and (p_pattern is null or r ->> 'error' ilike '%' || p_pattern || '%'), left(r::text, 500)); end $$;
create function rls_test.claims(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', rls_test.id(p_key), 'role', 'authenticated')::text, true) $$;
create function rls_test.today() returns date language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;
-- numeric field of the array element whose "unit" (or other key) matches
create function rls_test.pick(p_arr jsonb, p_key text, p_value text, p_field text) returns numeric language sql immutable as $$
  select (e ->> p_field)::numeric from jsonb_array_elements(coalesce(p_arr, '[]'::jsonb)) e where e ->> p_key = p_value limit 1 $$;
create function rls_test.n(p_key text, p_path text[]) returns numeric language sql stable as $$ select (rls_test.get(p_key) #>> p_path)::numeric $$;
create function rls_test.alert_ids(p jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(a ->> 'id' order by a ->> 'id'), '{}') from jsonb_array_elements(p -> 'alerts') a $$;
create function rls_test.has_alert(p jsonb, p_type text) returns boolean language sql immutable as $$
  select exists (select 1 from jsonb_array_elements(p -> 'alerts') a where a ->> 'type' = p_type) $$;

-- Owner-side probes
create function rls_test.sol(p_so uuid, p_product uuid) returns uuid language sql stable security definer as $$
  select id from public.sales_order_lines where sales_order_id = p_so and product_id = p_product $$;
create function rls_test.res_of(p_line uuid) returns uuid language sql stable security definer as $$
  select id from public.stock_reservations where reference_type = 'SALES_ORDER_LINE' and reference_id = p_line
    and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') order by quantity - fulfilled_quantity - released_quantity desc limit 1 $$;
create function rls_test.fl(p_ful uuid, p_product uuid) returns uuid language sql stable security definer as $$
  select id from public.fulfilment_lines where fulfilment_id = p_ful and product_id = p_product $$;
create function rls_test.iline(p_inv uuid, p_product uuid) returns uuid language sql stable security definer as $$
  select id from public.sales_invoice_lines where invoice_id = p_inv and product_id = p_product $$;
create function rls_test.lot(p_product uuid) returns uuid language sql stable security definer as $$
  select id from public.inventory_batches where product_id = p_product order by created_at limit 1 $$;
create function rls_test.material(p_order uuid, p_product uuid) returns uuid language sql stable security definer as $$
  select id from public.production_order_materials where production_order_id = p_order and component_product_id = p_product $$;
create function rls_test.quarantine_ineligible(p_company uuid, p_product uuid) returns boolean language sql stable security definer as $$
  select count(*) > 0 and bool_and(not eligible and ineligible_reason like 'Quarantine%')
  from private.po_eligible_stock(p_company, p_product, null) where stock_usage = 'QUARANTINE' $$;
-- Everything the analytics must never change.
create function rls_test.snapshot(p_company uuid) returns jsonb language sql stable security definer as $$
  select jsonb_build_object(
    'tx', (select count(*) from public.inventory_transactions where company_id = p_company),
    'on_hand', (select coalesce(sum(on_hand), 0) from public.inventory_balances where company_id = p_company),
    'reserved', (select coalesce(sum(reserved), 0) from public.inventory_balances where company_id = p_company),
    'reservations', (select count(*) || ':' || coalesce(sum(quantity - fulfilled_quantity - released_quantity), 0) from public.stock_reservations where company_id = p_company),
    'orders', (select count(*) || ':' || string_agg(order_status, ',' order by id) from public.sales_orders where company_id = p_company),
    'fulfilments', (select string_agg(fulfilment_status, ',' order by id) from public.fulfilments where company_id = p_company),
    'invoices', (select count(*) || ':' || coalesce(sum(grand_total), 0) || ':' || string_agg(status, ',' order by id) from public.sales_invoices where company_id = p_company),
    'payments', (select count(*) || ':' || coalesce(sum(amount_received), 0) from public.customer_payments where company_id = p_company),
    'allocations', (select count(*) || ':' || coalesce(sum(allocated_amount), 0) from public.invoice_payment_allocations where company_id = p_company and status = 'ACTIVE'),
    'notes', (select count(*) from public.invoice_adjustment_notes where company_id = p_company),
    'production', (select string_agg(status || completed_quantity, ',' order by id) from public.production_orders where company_id = p_company),
    'adjustments', (select string_agg(status, ',' order by id) from public.inventory_adjustments where company_id = p_company)) $$;
-- Runs pick -> pack -> ready (and optionally dispatch) for a new pick list; returns the fulfilment id.
create function rls_test.ship(p_so uuid, p_wh uuid, p_lines jsonb, p_dispatch boolean default true) returns uuid language plpgsql as $$
declare r jsonb; f uuid;
begin
  r := public.fulfilment_create(p_so, p_wh, p_lines, null, null, gen_random_uuid());
  f := (r ->> 'fulfilment_id')::uuid;
  perform public.fulfilment_pick(f, (select jsonb_agg(jsonb_build_object('line_id', id, 'quantity_picked', quantity_to_pick)) from public.fulfilment_line_list where fulfilment_id = f), true);
  perform public.fulfilment_pack(f, (select jsonb_agg(jsonb_build_object('line_id', id, 'quantity_packed', quantity_picked)) from public.fulfilment_line_list where fulfilment_id = f), null, true);
  perform public.fulfilment_action(f, 'READY');
  if p_dispatch then perform public.fulfilment_dispatch(f, '{}'::jsonb, gen_random_uuid()); end if;
  return f;
end $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e59000-0000-4000-8000-0000000000a1'), ('company_b', 'e7e59000-0000-4000-8000-0000000000b1'),
  ('adm', 'e7e59000-0000-4000-8000-000000000001'), ('sales', 'e7e59000-0000-4000-8000-000000000002'), ('im', 'e7e59000-0000-4000-8000-000000000003'),
  ('pm', 'e7e59000-0000-4000-8000-000000000004'), ('pm2', 'e7e59000-0000-4000-8000-000000000005'), ('acc', 'e7e59000-0000-4000-8000-000000000006'),
  ('viewer', 'e7e59000-0000-4000-8000-000000000007'), ('pur', 'e7e59000-0000-4000-8000-000000000008'), ('b_adm', 'e7e59000-0000-4000-8000-000000000009'),
  ('pa', 'e7e59000-0000-4000-8000-0000000000c1'), ('pb', 'e7e59000-0000-4000-8000-0000000000c2'), ('pf', 'e7e59000-0000-4000-8000-0000000000c3'),
  ('clay', 'e7e59000-0000-4000-8000-0000000000c4'), ('cat_s', 'e7e59000-0000-4000-8000-0000000000c5'), ('cat_r', 'e7e59000-0000-4000-8000-0000000000c6'),
  ('w1', 'e7e59000-0000-4000-8000-0000000000e1'), ('w2', 'e7e59000-0000-4000-8000-0000000000e2'), ('quar', 'e7e59000-0000-4000-8000-0000000000f1'),
  ('cu1', 'e7e59000-0000-4000-8000-0000000000d1'), ('cu2', 'e7e59000-0000-4000-8000-0000000000d2'), ('cu_b', 'e7e59000-0000-4000-8000-0000000000d3'),
  ('w_b', 'e7e59000-0000-4000-8000-0000000000e3'), ('pb_b', 'e7e59000-0000-4000-8000-0000000000c7');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code, legal_address, state, gstin) values
  (rls_test.id('company_a'), 'Analytics Test A Pvt Ltd', 'Analytics A', 'ANA', 'Plot 9, MIDC, Pune 411001', 'Maharashtra', '27AANCA1234B1Z5'),
  (rls_test.id('company_b'), 'Analytics Test B', 'Analytics B', 'ANB', null, null, null);
insert into auth.users (id, email) select id, key || '@an.example.invalid' from rls_test.ids where key in ('adm', 'sales', 'im', 'pm', 'pm2', 'acc', 'viewer', 'pur', 'b_adm');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true
  where id in (select id from rls_test.ids where key in ('adm', 'sales', 'im', 'pm', 'pm2', 'acc', 'viewer', 'pur'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_adm');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('adm'),    rls_test.id('company_a'), rls_test.id('role_admin')),
  (rls_test.id('sales'),  rls_test.id('company_a'), rls_test.id('role_sales_manager')),
  (rls_test.id('im'),     rls_test.id('company_a'), rls_test.id('role_inventory_manager')),
  (rls_test.id('pm'),     rls_test.id('company_a'), rls_test.id('role_production_manager')),
  (rls_test.id('pm2'),    rls_test.id('company_a'), rls_test.id('role_production_manager')),
  (rls_test.id('acc'),    rls_test.id('company_a'), rls_test.id('role_accounts_manager')),
  (rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_management_viewer')),
  (rls_test.id('pur'),    rls_test.id('company_a'), rls_test.id('role_purchase_manager')),
  (rls_test.id('b_adm'),  rls_test.id('company_b'), rls_test.id('role_admin'));

insert into public.product_categories (id, company_id, name, code) values
  (rls_test.id('cat_s'), rls_test.id('company_a'), 'Sanitary ware', 'SAN'), (rls_test.id('cat_r'), rls_test.id('company_a'), 'Raw materials', 'RAW');
insert into public.products (id, company_id, sku, product_name, category_id, product_type, default_source_type, base_unit, track_batches, track_expiry,
  hsn_code, gst_rate, selling_price, reorder_level, status) values
  (rls_test.id('pa'), rls_test.id('company_a'), 'AN-BASIN', 'Wash basin', rls_test.id('cat_s'), 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, '6910', 18, 1000, 50, 'ACTIVE'),
  (rls_test.id('pb'), rls_test.id('company_a'), 'AN-TAP', 'Tap (never stocked)', null, 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, null, null, null, null, 'ACTIVE'),
  (rls_test.id('pf'), rls_test.id('company_a'), 'AN-CLOSET', 'Closet', rls_test.id('cat_s'), 'FINISHED_GOOD', 'IN_HOUSE', 'NOS', false, false, null, null, null, null, 'ACTIVE'),
  (rls_test.id('clay'), rls_test.id('company_a'), 'AN-CLAY', 'Ceramic body', rls_test.id('cat_r'), 'RAW_MATERIAL', 'OUTSOURCED', 'KG', false, false, null, null, null, 30, 'ACTIVE'),
  (rls_test.id('pb_b'), rls_test.id('company_b'), 'B-ITEM', 'Company B item', null, 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, null, null, null, 5, 'ACTIVE');
insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Main', true), (rls_test.id('w2'), rls_test.id('company_a'), 'W2', 'Branch', false),
  (rls_test.id('w_b'), rls_test.id('company_b'), 'WB', 'B store', true);
insert into public.inventory_locations (id, company_id, warehouse_id, location_code, location_name, location_type, stock_usage) values
  (rls_test.id('quar'), rls_test.id('company_a'), rls_test.id('w1'), 'QUAR', 'Quarantine', 'AREA', 'QUARANTINE');
insert into rls_test.ids (key, id) select 'g1', id from public.inventory_locations where location_code = 'GENERAL' and warehouse_id = rls_test.id('w1');
insert into rls_test.ids (key, id) select 'g2', id from public.inventory_locations where location_code = 'GENERAL' and warehouse_id = rls_test.id('w2');
insert into rls_test.ids (key, id) select 'gb', id from public.inventory_locations where location_code = 'GENERAL' and warehouse_id = rls_test.id('w_b');
insert into public.customers (id, company_id, customer_code, customer_name, legal_name, gstin, gst_registration_type, billing_address, billing_state_code, payment_terms_days) values
  (rls_test.id('cu1'), rls_test.id('company_a'), 'C1', 'Pune Traders', 'Pune Traders LLP', '27PQRST5678K1Z2', 'REGISTERED', 'Kothrud, Pune', '27', 30),
  (rls_test.id('cu2'), rls_test.id('company_a'), 'C2', 'Mumbai Builders', null, '27LMNOP4321Q1Z9', 'REGISTERED', 'Andheri, Mumbai', '27', 30),
  (rls_test.id('cu_b'), rls_test.id('company_b'), 'B1', 'B buyer', null, null, null, null, null, null);

select rls_test.ok('no analytics copy of operational data: no new base tables were added by Phase 9',
  not exists (select 1 from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'
    and (table_name like 'analytics%' or table_name like '%_summary' or table_name like 'dashboard%' or table_name like 'kpi%')));
select rls_test.ok('analytics functions are not executable by anonymous users',
  not has_function_privilege('anon', 'public.analytics_executive(date, date, date, uuid, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.analytics_alerts(date)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.analytics_data_quality()', 'EXECUTE'));
select rls_test.ok('private analytics helpers cannot be called by signed-in users (only through permission-checked functions)',
  not has_function_privilege('authenticated', 'private.analytics_sales_kpis(uuid, date, date, uuid, uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.analytics_open_demand(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.analytics_valuation(uuid, uuid, uuid)', 'EXECUTE'));

-- ---------------------------------------------------------------------------
-- Operational records through the real workflows
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('im');
select public.inventory_post_receipt(rls_test.id('pa'), rls_test.id('g1'), 100, 'IN_HOUSE', p_unit_cost => 500, p_idempotency_key => gen_random_uuid());
select public.inventory_post_receipt(rls_test.id('pa'), rls_test.id('g1'), 20, 'OUTSOURCED', p_idempotency_key => gen_random_uuid());
select rls_test.expect_call_ok('setup: 5 basins received into the quarantine location', 'q_receipt',
  format($q$ select public.inventory_post_receipt(%L, %L, 5, 'IN_HOUSE', p_unit_cost => 500, p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('pa'), rls_test.id('quar')));
select public.inventory_post_receipt(rls_test.id('clay'), rls_test.id('g1'), 200, 'IN_HOUSE', p_unit_cost => 10, p_idempotency_key => gen_random_uuid());
select rls_test.expect_call_ok('setup: 10 in-house basins transferred W1 -> W2', 'transfer',
  format($q$ select public.inventory_transfer_stock(%L, %L, %L, 10, null, 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.id('pa'), rls_test.id('g1'), rls_test.id('g2')));

select rls_test.claims('sales');
select rls_test.set('so1', public.sales_order_create_manual(jsonb_build_object('customer_id', rls_test.id('cu1'), 'warehouse_id', rls_test.id('w1')),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('pa'), 'quantity', 30, 'unit_price', 1000)), true, gen_random_uuid()));
select rls_test.set('so2', public.sales_order_create_manual(jsonb_build_object('customer_id', rls_test.id('cu2'), 'warehouse_id', rls_test.id('w1')),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('pa'), 'quantity', 200, 'unit_price', 900)), true, gen_random_uuid()));
select rls_test.set('so3', public.sales_order_create_manual(jsonb_build_object('customer_id', rls_test.id('cu1'), 'warehouse_id', rls_test.id('w1')),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('pb'), 'quantity', 5)), true, gen_random_uuid()));
select rls_test.set('so4', public.sales_order_create_manual(jsonb_build_object('customer_id', rls_test.id('cu2'), 'warehouse_id', rls_test.id('w1')),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('pa'), 'quantity', 1, 'unit_price', 1000)), false, gen_random_uuid()));
select public.sales_order_cancel(rls_test.gid('so4', 'sales_order_id'), 'Customer withdrew the order', gen_random_uuid());
select public.sales_order_allocate(rls_test.gid('so1', 'sales_order_id'), 'IN_HOUSE_FIRST', null, true, gen_random_uuid());
select public.sales_order_allocate(rls_test.gid('so2', 'sales_order_id'), 'IN_HOUSE_FIRST', null, true, gen_random_uuid());

select rls_test.claims('im');
select rls_test.set('f1', to_jsonb(rls_test.ship(rls_test.gid('so1', 'sales_order_id'), rls_test.id('w1'),
  jsonb_build_array(jsonb_build_object('reservation_id', rls_test.res_of(rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('pa'))), 'quantity', 10)))));
select rls_test.set('f2', to_jsonb(rls_test.ship(rls_test.gid('so1', 'sales_order_id'), rls_test.id('w1'),
  jsonb_build_array(jsonb_build_object('reservation_id', rls_test.res_of(rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('pa'))), 'quantity', 5)))));
select rls_test.set('f3', to_jsonb(rls_test.ship(rls_test.gid('so2', 'sales_order_id'), rls_test.id('w1'),
  jsonb_build_array(jsonb_build_object('reservation_id', rls_test.res_of(rls_test.sol(rls_test.gid('so2', 'sales_order_id'), rls_test.id('pa'))), 'quantity', 5)), false)));
select rls_test.expect_call_ok('setup: pending stock adjustment (clay counted 170, awaiting approval)', 'adj',
  format($q$ select public.inventory_create_adjustment('QUANTITY', %L, %L, 'DAMAGE', p_source_type => 'IN_HOUSE', p_counted_quantity => 170, p_notes => 'Wet sacks found', p_submit => true, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.id('clay'), rls_test.id('g1')));
reset role;
insert into rls_test.ids values ('f1', (rls_test.get('f1') #>> '{}')::uuid), ('f2', (rls_test.get('f2') #>> '{}')::uuid), ('f3', (rls_test.get('f3') #>> '{}')::uuid);
insert into rls_test.ids values ('fl1', rls_test.fl(rls_test.id('f1'), rls_test.id('pa'))), ('fl2', rls_test.fl(rls_test.id('f2'), rls_test.id('pa')));
set local role authenticated;

-- Billing: INV-1 issued for F1 (10 basins), a draft for F2 (5 basins), 5000 received of which 3000 allocated, credit note for 1 basin.
select rls_test.claims('acc');
select rls_test.expect_call_ok('setup: draft invoice for the first dispatch', 'inv1',
  format($q$ select public.sales_invoice_create_draft(%L::jsonb, '{}'::jsonb, gen_random_uuid()) $q$, jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.id('fl1')))));
select rls_test.expect_call_ok('setup: INV-1 issued (10 x 1000 + 18% GST = 11800)', 'inv1_issue',
  format($q$ select public.sales_invoice_issue(%L, gen_random_uuid()) $q$, rls_test.gid('inv1', 'invoice_id')));
select rls_test.expect_call_ok('setup: draft invoice for the second dispatch (not issued)', 'inv2',
  format($q$ select public.sales_invoice_create_draft(%L::jsonb, '{}'::jsonb, gen_random_uuid()) $q$, jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.id('fl2')))));
select rls_test.expect_call_ok('setup: receipt of 5000, 3000 allocated to INV-1', 'pay1',
  format($q$ select public.customer_payment_record(%L::jsonb, %L::jsonb, gen_random_uuid()) $q$,
    jsonb_build_object('customer_id', rls_test.id('cu1'), 'receipt_date', rls_test.today(), 'amount', '5000', 'payment_method', 'BANK_TRANSFER', 'transaction_reference', 'UTR-AN-1'),
    jsonb_build_array(jsonb_build_object('invoice_id', rls_test.gid('inv1', 'invoice_id'), 'amount', '3000'))));
select rls_test.expect_call_ok('setup: credit note draft for 1 basin', 'cn1',
  format($q$ select public.adjustment_note_create(%L, 'CREDIT', %L::jsonb, %L::jsonb, gen_random_uuid()) $q$, rls_test.gid('inv1', 'invoice_id'),
    jsonb_build_object('reason_code', 'QUALITY_ISSUE', 'reason', 'Chipped basin'),
    jsonb_build_array(jsonb_build_object('invoice_line_id', rls_test.iline(rls_test.gid('inv1', 'invoice_id'), rls_test.id('pa')), 'quantity', 1))));
select rls_test.expect_call_ok('setup: credit note issued (1000 + 180 = 1180)', 'cn1_issue',
  format($q$ select public.adjustment_note_issue(%L, gen_random_uuid()) $q$, rls_test.gid('cn1', 'note_id')));

-- Production: BOM (closet <- 2.5 KG clay), P1 planned 10 due yesterday, started, 25 KG issued, 4 good + 1 scrap; P2 draft.
select rls_test.claims('pm');
select rls_test.expect_call_ok('setup: BOM saved', 'bom',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('pf'), rls_test.today() - 30,
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('clay'), 'quantity_required', 2.5))));
select public.production_bom_action(rls_test.gid('bom', 'bom_id'), 'SUBMIT');
select rls_test.claims('pm2');
select rls_test.expect_call_ok('setup: BOM approved by a second production manager', 'bom_ok', format($q$ select public.production_bom_action(%L, 'APPROVE') $q$, rls_test.gid('bom', 'bom_id')));
select rls_test.claims('pm');
select rls_test.expect_call_ok('setup: P1 planned 10 closets, target yesterday', 'p1',
  format($q$ select public.production_save_order(null, %L, 10, %L, %L, %L, %L, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('bom', 'bom_id'), rls_test.id('w1'), rls_test.id('w1'), rls_test.today() - 3, rls_test.today() - 1));
select rls_test.expect_call_ok('setup: P2 planned 5 closets (draft only)', 'p2',
  format($q$ select public.production_save_order(null, %L, 5, %L, %L, %L, %L, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('bom', 'bom_id'), rls_test.id('w1'), rls_test.id('w1'), rls_test.today(), rls_test.today() + 5));
select public.production_order_action(rls_test.gid('p1', 'order_id'), 'SUBMIT');
select rls_test.claims('pm2');
select public.production_order_action(rls_test.gid('p1', 'order_id'), 'APPROVE');
select rls_test.claims('pm');
select rls_test.expect_call_ok('setup: P1 started', 'p1_start', format($q$ select public.production_order_action(%L, 'START') $q$, rls_test.gid('p1', 'order_id')));
reset role;
insert into rls_test.ids values ('m_clay', rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('clay'))), ('lot_clay', rls_test.lot(rls_test.id('clay')));
set local role authenticated;
select rls_test.expect_call_ok('setup: 25 KG clay issued to P1', 'p1_issue',
  format($q$ select public.production_issue_materials(%L, %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('p1', 'order_id'),
    jsonb_build_array(jsonb_build_object('order_material_id', rls_test.id('m_clay'), 'batch_id', rls_test.id('lot_clay'), 'location_id', rls_test.id('g1'), 'quantity', 25))));
select rls_test.expect_call_ok('setup: P1 output 4 good + 1 scrap', 'p1_out',
  format($q$ select public.production_receive_output(%L, 4, 0, 1, %L, p_rejection_reason => 'Cracked in firing', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('p1', 'order_id'), rls_test.id('g1')));

-- Company B: one small receipt so isolation is tested against real data.
select rls_test.claims('b_adm');
reset role;
insert into public.user_roles (user_id, company_id, role_id) values (rls_test.id('b_adm'), rls_test.id('company_b'), rls_test.id('role_inventory_manager'));
set local role authenticated;
select rls_test.claims('b_adm');
select public.inventory_post_receipt(rls_test.id('pb_b'), rls_test.id('gb'), 3, 'IN_HOUSE', p_idempotency_key => gen_random_uuid());

reset role;
select rls_test.set('snap_before', rls_test.snapshot(rls_test.id('company_a')));
select rls_test.set('snap_b_before', rls_test.snapshot(rls_test.id('company_b')));
set local role authenticated;

-- ===========================================================================
-- EXECUTIVE KPIs (Admin, period = last 10 days .. today)
-- ===========================================================================
select rls_test.claims('adm');
select rls_test.expect_call_ok('context: company, timezone, financial-year start and module access for the Admin', 'ctx', $q$ select public.analytics_context() $q$);
select rls_test.ok('context: Admin may see every section and data quality; currency INR',
  (rls_test.get('ctx') #>> '{company,legal_name}') = 'Analytics Test A Pvt Ltd' and (rls_test.get('ctx') #>> '{access,data_quality}')::boolean
  and (rls_test.get('ctx') #>> '{access,billing}')::boolean and (rls_test.get('ctx') #>> '{company,currency_code}') = 'INR'
  and (rls_test.get('ctx') ->> 'fy_start_month')::int = 4 and jsonb_array_length(rls_test.get('ctx') -> 'warehouses') = 2, rls_test.get('ctx')::text);
select rls_test.expect_call_ok('executive: KPIs load for the selected period', 'ex',
  format($q$ select public.analytics_executive(%L, %L) $q$, rls_test.today() - 10, rls_test.today()));

select rls_test.ok('sales KPI: 3 orders created (cancelled order excluded)', rls_test.n('ex', '{sales,orders_created}') = 3, rls_test.get('ex') ->> 'sales');
select rls_test.ok('sales KPI: order value from price snapshots 30 x 1000 + 200 x 900 = 210000; the unpriced line is counted, not valued',
  rls_test.n('ex', '{sales,order_value}') = 210000 and rls_test.n('ex', '{sales,unpriced_order_lines}') = 1);
select rls_test.ok('sales KPI: partial dispatches counted correctly: 2 dispatches, 15 PCS, dispatched value 15000 (ready-but-undispatched F3 excluded)',
  rls_test.n('ex', '{sales,dispatches_completed}') = 2 and rls_test.pick(rls_test.get('ex') #> '{sales,quantity_dispatched}', 'unit', 'PCS', 'quantity') = 15
  and rls_test.n('ex', '{sales,dispatched_value}') = 15000);
select rls_test.ok('sales KPI: 3 orders awaiting fulfilment, 2 with shortages (SO-2 pa, SO-3 tap), 1 partially fulfilled',
  rls_test.n('ex', '{sales,orders_awaiting_fulfilment}') = 3 and rls_test.n('ex', '{sales,orders_with_shortages}') = 2 and rls_test.n('ex', '{sales,partially_fulfilled}') = 1,
  rls_test.get('ex') ->> 'sales');
select rls_test.ok('billing KPI: draft invoice excluded; 1 issued invoice of 11800',
  rls_test.n('ex', '{billing,invoices_issued}') = 1 and rls_test.n('ex', '{billing,invoiced_total}') = 11800, rls_test.get('ex') ->> 'billing');
select rls_test.ok('billing KPI: collections = recorded receipt amount (5000), not invoice or order value',
  rls_test.n('ex', '{billing,payments_received}') = 5000);
select rls_test.ok('billing KPI: partial allocation and credit note reduce receivables once: 11800 - 1180 - 3000 = 7620; credit notes shown separately (1180)',
  rls_test.n('ex', '{billing,outstanding}') = 7620 and rls_test.n('ex', '{billing,credit_notes_total}') = 1180 and rls_test.n('ex', '{billing,partially_paid}') = 1);
select rls_test.ok('billing KPI: not yet overdue as of today; 2000 of the receipt is unallocated',
  rls_test.n('ex', '{billing,overdue}') = 0 and rls_test.n('ex', '{billing,overdue_invoices}') = 0 and rls_test.n('ex', '{billing,unallocated_receipts}') = 2000);
select rls_test.ok('inventory KPI: PCS on hand 110 = 125 received - 15 dispatched (the transfer moved stock without changing the total)',
  rls_test.pick(rls_test.get('ex') #> '{inventory,units}', 'unit', 'PCS', 'on_hand') = 110, rls_test.get('ex') #>> '{inventory,units}');
select rls_test.ok('inventory KPI: reservations reduce available, not on hand: reserved 95, available = storage 105 - 95 = 10; quarantine 5 never available',
  rls_test.pick(rls_test.get('ex') #> '{inventory,units}', 'unit', 'PCS', 'reserved') = 95
  and rls_test.pick(rls_test.get('ex') #> '{inventory,units}', 'unit', 'PCS', 'available') = 10
  and rls_test.pick(rls_test.get('ex') #> '{inventory,units}', 'unit', 'PCS', 'quarantine') = 5);
select rls_test.ok('inventory KPI: in-house 90 / outsourced 20 from the lots'' actual source',
  rls_test.pick(rls_test.get('ex') #> '{inventory,units}', 'unit', 'PCS', 'in_house') = 90
  and rls_test.pick(rls_test.get('ex') #> '{inventory,units}', 'unit', 'PCS', 'outsourced') = 20);
select rls_test.ok('inventory KPI: units are never added together (PCS, NOS and KG reported separately: 110 / 4 / 175)',
  jsonb_array_length(rls_test.get('ex') #> '{inventory,units}') = 3
  and rls_test.pick(rls_test.get('ex') #> '{inventory,units}', 'unit', 'NOS', 'on_hand') = 4
  and rls_test.pick(rls_test.get('ex') #> '{inventory,units}', 'unit', 'KG', 'on_hand') = 175);
select rls_test.ok('inventory KPI: 4 active products, 1 below reorder level (basin 10 <= 50), 1 never stocked (tap)',
  rls_test.n('ex', '{inventory,active_products}') = 4 and rls_test.n('ex', '{inventory,low_stock_products}') = 1
  and rls_test.n('ex', '{inventory,never_stocked_products}') = 1 and rls_test.n('ex', '{inventory,out_of_stock_products}') = 0);
select rls_test.ok('inventory KPI: shortages of 2 products; 115 PCS short (basin 120 needed - 10 eligible in W2; tap 5)',
  rls_test.n('ex', '{inventory,shortage_products}') = 2 and rls_test.pick(rls_test.get('ex') #> '{inventory,shortage_units}', 'unit', 'PCS', 'quantity') = 115,
  rls_test.get('ex') ->> 'inventory');
select rls_test.ok('inventory KPI: stock by warehouse (W1 PCS 100 incl. quarantine, W2 PCS 10)',
  (select (e ->> 'on_hand')::numeric from jsonb_array_elements(rls_test.get('ex') #> '{inventory,by_warehouse}') e where e ->> 'warehouse_code' = 'W1' and e ->> 'unit' = 'PCS') = 100
  and (select (e ->> 'on_hand')::numeric from jsonb_array_elements(rls_test.get('ex') #> '{inventory,by_warehouse}') e where e ->> 'warehouse_code' = 'W2' and e ->> 'unit' = 'PCS') = 10);
select rls_test.ok('valuation: one lot has no cost, so no value is invented ("Valuation unavailable — cost data required")',
  not (rls_test.get('ex') #>> '{valuation,available}')::boolean and rls_test.get('ex') #> '{valuation,value}' = 'null'::jsonb
  and rls_test.get('ex') #>> '{valuation,reason}' like 'Valuation unavailable — cost data required%'
  and rls_test.n('ex', '{valuation,costed_lots}') < rls_test.n('ex', '{valuation,lots}'), rls_test.get('ex') ->> 'valuation');
select rls_test.ok('production KPI: planned production is not completed output: P1 due, 0 completed (rate 0%), good 4 of 10 planned, 1 scrap',
  rls_test.n('ex', '{production,orders_due}') = 1 and rls_test.n('ex', '{production,orders_completed}') = 0
  and rls_test.n('ex', '{production,completion_rate}') = 0
  and rls_test.pick(rls_test.get('ex') #> '{production,planned_vs_actual}', 'unit', 'NOS', 'planned') = 10
  and rls_test.pick(rls_test.get('ex') #> '{production,planned_vs_actual}', 'unit', 'NOS', 'good') = 4
  and rls_test.pick(rls_test.get('ex') #> '{production,output_in_period}', 'unit', 'NOS', 'scrap') = 1, rls_test.get('ex') ->> 'production');
select rls_test.ok('production KPI: 2 orders created (the draft is not output); 1 delayed past its target date',
  rls_test.n('ex', '{production,orders_created}') = 2 and rls_test.n('ex', '{production,delayed_orders}') = 1
  and rls_test.n('ex', '{production,orders_in_progress}') = 1);

-- Date filters vs current state
select rls_test.expect_call_ok('date filter: an earlier period (days 20-11 ago) loads', 'ex_old',
  format($q$ select public.analytics_executive(%L, %L) $q$, rls_test.today() - 20, rls_test.today() - 11));
select rls_test.ok('date filter: period KPIs follow the dates (no orders, dispatches, invoices or receipts 20-11 days ago)',
  rls_test.n('ex_old', '{sales,orders_created}') = 0 and rls_test.n('ex_old', '{sales,dispatched_value}') = 0
  and rls_test.n('ex_old', '{billing,invoices_issued}') = 0 and rls_test.n('ex_old', '{billing,payments_received}') = 0
  and rls_test.n('ex_old', '{production,orders_created}') = 0);
select rls_test.ok('date filter: current stock does not change with the reporting dates', rls_test.get('ex_old') -> 'inventory' = rls_test.get('ex') -> 'inventory');
select rls_test.ok('date filter: receivables follow the reporting date (as of 11 days ago nothing was invoiced yet)',
  rls_test.n('ex_old', '{billing,outstanding}') = 0 and (rls_test.get('ex_old') ->> 'as_of')::date = rls_test.today() - 11);
select rls_test.expect_call_ok('filters: warehouse W2 and category filters load', 'ex_w2',
  format($q$ select public.analytics_executive(%L, %L, null, %L, null) $q$, rls_test.today() - 10, rls_test.today(), rls_test.id('w2')));
select rls_test.ok('filters: W2 holds only the 10 transferred basins and no orders or dispatches',
  rls_test.pick(rls_test.get('ex_w2') #> '{inventory,units}', 'unit', 'PCS', 'on_hand') = 10 and jsonb_array_length(rls_test.get('ex_w2') #> '{inventory,units}') = 1
  and rls_test.n('ex_w2', '{sales,orders_created}') = 0 and rls_test.n('ex_w2', '{sales,dispatched_value}') = 0);
select rls_test.ok('filters: category "Raw materials" has no sales value',
  (public.analytics_executive(rls_test.today() - 10, rls_test.today(), null, null, rls_test.id('cat_r')) #>> '{sales,order_value}')::numeric = 0);
select rls_test.expect_call_error('filters: an invalid period is refused', format($q$ select public.analytics_executive(%L, %L) $q$, rls_test.today(), rls_test.today() - 1), 'valid date range');

-- ===========================================================================
-- SALES ANALYTICS
-- ===========================================================================
select rls_test.expect_call_ok('sales analytics: load', 'sa', format($q$ select public.analytics_sales(%L, %L) $q$, rls_test.today() - 10, rls_test.today()));
select rls_test.ok('sales analytics: monthly series add up to the totals (order, dispatched, invoiced)',
  (select sum((m ->> 'order_value')::numeric) from jsonb_array_elements(rls_test.get('sa') -> 'monthly') m) = rls_test.n('sa', '{totals,order_value}')
  and (select sum((m ->> 'dispatched_value')::numeric) from jsonb_array_elements(rls_test.get('sa') -> 'monthly') m) = rls_test.n('sa', '{totals,dispatched_value}')
  and (select sum((m ->> 'invoiced_value')::numeric) from jsonb_array_elements(rls_test.get('sa') -> 'monthly') m) = rls_test.n('sa', '{totals,invoiced_value}'));
select rls_test.ok('sales analytics: dispatched (15000) and invoiced (10000 taxable) are different measures; credit notes separate (1000)',
  rls_test.n('sa', '{totals,dispatched_value}') = 15000 and rls_test.n('sa', '{totals,invoiced_value}') = 10000 and rls_test.n('sa', '{totals,credit_notes}') = 1000,
  rls_test.get('sa') ->> 'totals');
select rls_test.ok('sales analytics: top customers by order value (Mumbai Builders 180000), by dispatched (Pune Traders 15000) and invoiced (10000)',
  rls_test.get('sa') #>> '{top_customers_ordered,0,customer}' = 'Mumbai Builders' and rls_test.n('sa', '{top_customers_ordered,0,value}') = 180000
  and rls_test.get('sa') #>> '{top_customers_dispatched,0,customer}' = 'Pune Traders' and rls_test.n('sa', '{top_customers_dispatched,0,value}') = 15000
  and rls_test.n('sa', '{top_customers_invoiced,0,value}') = 10000
  and rls_test.get('sa') #>> '{top_customers_ordered,0,customer_id}' = rls_test.id('cu2')::text);
select rls_test.ok('sales analytics: by product and category (basin 230 PCS ordered, 210000; Sanitary ware 210000)',
  rls_test.pick(rls_test.get('sa') -> 'by_product', 'sku', 'AN-BASIN', 'ordered') = 230 and rls_test.pick(rls_test.get('sa') -> 'by_product', 'sku', 'AN-BASIN', 'order_value') = 210000
  and rls_test.pick(rls_test.get('sa') -> 'by_category', 'category', 'Sanitary ware', 'order_value') = 210000);
select rls_test.ok('sales analytics: salesperson analysis is reported unavailable (no salesperson recorded)', not (rls_test.get('sa') #>> '{salesperson,available}')::boolean);
select rls_test.ok('sales analytics: fulfilment 15 of 235 PCS (6.4%); no order fully dispatched',
  rls_test.pick(rls_test.get('sa') #> '{fulfilment,units}', 'unit', 'PCS', 'ordered') = 235 and rls_test.pick(rls_test.get('sa') #> '{fulfilment,units}', 'unit', 'PCS', 'dispatched') = 15
  and rls_test.pick(rls_test.get('sa') #> '{fulfilment,units}', 'unit', 'PCS', 'rate') = 6.4 and rls_test.n('sa', '{fulfilment,fully_dispatched}') = 0
  and rls_test.n('sa', '{fulfilment,partially_dispatched}') = 1);
select rls_test.ok('sales analytics: shortage analysis lists SO-2 short by 120 and SO-3 by 5',
  rls_test.n('sa', '{open_lines,short_lines}') = 2 and rls_test.pick(rls_test.get('sa') #> '{open_lines,rows}', 'sales_order_number',
    rls_test.get('so2') ->> 'sales_order_number', 'shortage') = 120);
select rls_test.ok('sales analytics: a customer filter narrows every series (Pune Traders: 30000 ordered, no Mumbai orders)',
  (public.analytics_sales(rls_test.today() - 10, rls_test.today(), rls_test.id('cu1')) #>> '{totals,order_value}')::numeric = 30000);

-- ===========================================================================
-- INVENTORY ANALYTICS
-- ===========================================================================
select rls_test.expect_call_ok('inventory analytics: load (today)', 'ia', format($q$ select public.analytics_inventory(%L, %L, p_bucket => 'day') $q$, rls_test.today(), rls_test.today()));
select rls_test.ok('inventory analytics: historical closing balance from the ledger equals the current balance today (PCS 110, KG 175, NOS 4)',
  rls_test.pick(rls_test.get('ia') #> '{period,balances}', 'unit', 'PCS', 'closing') = 110 and rls_test.pick(rls_test.get('ia') #> '{period,balances}', 'unit', 'PCS', 'opening') = 0
  and rls_test.pick(rls_test.get('ia') #> '{period,balances}', 'unit', 'KG', 'closing') = 175 and rls_test.pick(rls_test.get('ia') #> '{period,balances}', 'unit', 'NOS', 'closing') = 4);
select rls_test.ok('inventory analytics: transfers are not counted as receipts or issues (PCS in 125, out 15)',
  (select sum((e ->> 'in')::numeric) from jsonb_array_elements(rls_test.get('ia') #> '{period,trend}') e where e ->> 'unit' = 'PCS') = 125
  and (select sum((e ->> 'out')::numeric) from jsonb_array_elements(rls_test.get('ia') #> '{period,trend}') e where e ->> 'unit' = 'PCS') = 15
  and not exists (select 1 from jsonb_array_elements(rls_test.get('ia') #> '{period,by_type}') e where e ->> 'transaction_type' like 'TRANSFER%'));
select rls_test.ok('inventory analytics: one transfer between warehouses W1 -> W2 of 10 PCS',
  rls_test.n('ia', '{period,transfers,count}') = 1 and rls_test.n('ia', '{period,transfers,between_warehouses}') = 1
  and rls_test.get('ia') #>> '{period,transfers,routes,0,from}' = 'W1' and rls_test.n('ia', '{period,transfers,routes,0,quantity}') = 10);
select rls_test.ok('inventory analytics: reservation utilisation 95 of 105 PCS storage stock; source split 90 / 20',
  rls_test.pick(rls_test.get('ia') #> '{current,reservation_utilisation}', 'unit', 'PCS', 'reserved') = 95
  and rls_test.pick(rls_test.get('ia') #> '{current,reservation_utilisation}', 'unit', 'PCS', 'storage_on_hand') = 105
  and rls_test.pick(rls_test.get('ia') #> '{current,by_source}', 'unit', 'PCS', 'in_house') = 90);
select rls_test.ok('inventory analytics: below reorder (basin) and zero-stock (tap) lists; pending adjustment counted',
  rls_test.n('ia', '{current,below_reorder_count}') = 1 and rls_test.get('ia') #>> '{current,below_reorder,0,sku}' = 'AN-BASIN'
  and rls_test.n('ia', '{current,zero_stock_count}') = 1 and rls_test.n('ia', '{period,adjustments,pending_approval}') = 1);
select rls_test.expect_call_ok('inventory analytics: an earlier period loads', 'ia_old',
  format($q$ select public.analytics_inventory(%L, %L) $q$, rls_test.today() - 20, rls_test.today() - 11));
select rls_test.ok('inventory analytics: historical balance 11 days ago is 0 while the current snapshot is unchanged',
  coalesce(rls_test.pick(rls_test.get('ia_old') #> '{period,balances}', 'unit', 'PCS', 'closing'), 0) = 0
  and rls_test.get('ia_old') #> '{current,by_warehouse}' = rls_test.get('ia') #> '{current,by_warehouse}');
select rls_test.ok('inventory analytics: source filter OUTSOURCED shows only the 20 outsourced basins',
  rls_test.pick(public.analytics_inventory(rls_test.today(), rls_test.today(), null, null, 'OUTSOURCED') #> '{current,by_source}', 'unit', 'PCS', 'outsourced') = 20
  and rls_test.pick(public.analytics_inventory(rls_test.today(), rls_test.today(), null, null, 'OUTSOURCED') #> '{current,by_source}', 'unit', 'PCS', 'in_house') = 0);
select rls_test.ok('quarantine: returned / quarantined stock is not eligible for allocation (Phase 6 eligibility corrected)',
  rls_test.quarantine_ineligible(rls_test.id('company_a'), rls_test.id('pa')));

-- ===========================================================================
-- PRODUCTION ANALYTICS
-- ===========================================================================
select rls_test.expect_call_ok('production analytics: load', 'pa', format($q$ select public.analytics_production(%L, %L) $q$, rls_test.today() - 10, rls_test.today()));
select rls_test.ok('production analytics: planned 10 vs good 4 (40%), consumption 25 KG on P1, P1 overdue',
  rls_test.pick(rls_test.get('pa') -> 'planned_vs_actual', 'unit', 'NOS', 'rate') = 40
  and rls_test.pick(rls_test.get('pa') -> 'consumption_by_order', 'unit', 'KG', 'quantity') = 25
  and rls_test.n('pa', '{overdue_count}') = 1 and rls_test.get('pa') #>> '{overdue_orders,0,order_number}' = rls_test.get('p1') ->> 'production_order_number', left(rls_test.get('pa')::text, 1500));
select rls_test.ok('production analytics: outsourcing section available to the Admin (no outsourcing orders yet)',
  (rls_test.get('pa') #>> '{outsourcing,available}')::boolean and jsonb_array_length(rls_test.get('pa') #> '{outsourcing,overdue}') = 0);

-- ===========================================================================
-- PURCHASE ORDER & FULFILMENT, SHORTAGE REPORT
-- ===========================================================================
select rls_test.expect_call_ok('fulfilment pipeline: load', 'fp', format($q$ select public.analytics_fulfilment(%L, %L) $q$, rls_test.today() - 10, rls_test.today()));
select rls_test.ok('fulfilment pipeline: 1 order awaiting dispatch (F3 ready), 1 partially dispatched, 0 of 3 fully dispatched',
  rls_test.n('fp', '{sales_orders,awaiting_dispatch}') = 1 and rls_test.n('fp', '{sales_orders,partially_dispatched}') = 1
  and rls_test.n('fp', '{sales_orders,orders_in_period}') = 3 and rls_test.n('fp', '{sales_orders,fulfilment_rate}') = 0
  and (rls_test.get('fp') #>> '{purchase_orders,available}')::boolean, rls_test.get('fp')::text);
select rls_test.claims('sales');
select rls_test.expect_call_ok('shortage report: Sales Manager loads it', 'sh', $q$ select public.analytics_shortages() $q$);
select rls_test.ok('shortage report: SO-2 basin short 120 (W1 has none free), tap short 5 with a replenishment suggestion; nothing reserved by viewing',
  rls_test.n('sh', '{total}') = 2
  and rls_test.pick(rls_test.get('sh') -> 'rows', 'sku', 'AN-BASIN', 'shortage') = 120 and rls_test.pick(rls_test.get('sh') -> 'rows', 'sku', 'AN-BASIN', 'reserved') = 80
  and (select e ->> 'next_action' from jsonb_array_elements(rls_test.get('sh') -> 'rows') e where e ->> 'sku' = 'AN-TAP') = 'review replenishment (no BOM)',
  left(rls_test.get('sh')::text, 1500));
select rls_test.ok('shortage report: product totals subtract shared stock once (basin 120 required - 10 free in W2 = 110)',
  rls_test.pick(rls_test.get('sh') -> 'product_totals', 'sku', 'AN-BASIN', 'net_shortage') = 110);
select rls_test.ok('shortage report: paginated on the server (page size 1 returns 1 of 2 rows)',
  jsonb_array_length(public.analytics_shortages(p_limit => 1) -> 'rows') = 1 and (public.analytics_shortages(p_limit => 1) ->> 'total')::int = 2);
select rls_test.expect_call_error('shortage report: oversized pages are refused', $q$ select public.analytics_shortages(p_limit => 5000) $q$, 'Page size');

-- ===========================================================================
-- FINANCIAL OVERVIEW
-- ===========================================================================
select rls_test.claims('acc');
select rls_test.expect_call_ok('finance: load as of today', 'fi', format($q$ select public.analytics_finance(%L, %L) $q$, rls_test.today() - 10, rls_test.today()));
select rls_test.ok('finance: invoiced 11800, collected 5000, outstanding 7620, unallocated 2000; monthly series add up',
  rls_test.n('fi', '{totals,invoiced}') = 11800 and rls_test.n('fi', '{totals,collected}') = 5000 and rls_test.n('fi', '{totals,outstanding}') = 7620
  and rls_test.n('fi', '{totals,unallocated}') = 2000
  and (select sum((m ->> 'invoiced')::numeric) from jsonb_array_elements(rls_test.get('fi') -> 'monthly') m) = 11800
  and (select sum((m ->> 'collected')::numeric) from jsonb_array_elements(rls_test.get('fi') -> 'monthly') m) = 5000);
select rls_test.ok('finance: collection rate = 3000 allocated / (3000 + 7620 open) = 28.2%', rls_test.n('fi', '{collection_rate,percent}') = 28.2,
  rls_test.get('fi') ->> 'collection_rate');
select rls_test.ok('finance: average collection time unavailable (no invoice fully settled), not invented',
  rls_test.n('fi', '{collection_time,invoices}') = 0 and rls_test.get('fi') #> '{collection_time,average_days}' = 'null'::jsonb);
select rls_test.ok('finance: profit, net income and cash flow are listed as unavailable with the data needed',
  jsonb_array_length(rls_test.get('fi') -> 'unavailable_metrics') = 3 and rls_test.get('fi') #>> '{unavailable_metrics,0,metric}' like 'Profit%');
select rls_test.expect_call_ok('finance: load as of 45 days later', 'fi45',
  format($q$ select public.analytics_finance(%L, %L, %L) $q$, rls_test.today() - 10, rls_test.today(), rls_test.today() + 45));
select rls_test.ok('finance: overdue follows the reporting date (7620 overdue 15 days, bucket 1-30)',
  rls_test.n('fi45', '{totals,overdue}') = 7620 and rls_test.pick(rls_test.get('fi45') -> 'ageing', 'bucket', '1_30', 'amount') = 7620
  and rls_test.n('fi45', '{top_overdue,0,oldest_days_overdue}') = 15);
select rls_test.ok('finance: upcoming due dates within 30 days of the reporting date', jsonb_array_length(rls_test.get('fi') -> 'upcoming_due') = 1
  and rls_test.n('fi', '{upcoming_due_total}') = 7620);

-- ===========================================================================
-- ALERTS
-- ===========================================================================
select rls_test.claims('adm');
select rls_test.expect_call_ok('alerts: load', 'al', $q$ select public.analytics_alerts() $q$);
select rls_test.expect_call_ok('alerts: refresh', 'al2', $q$ select public.analytics_alerts() $q$);
select rls_test.ok('alerts: real exceptions only (low stock, SO shortages, awaiting dispatch, production delay, unallocated receipt, pending adjustment); none overdue yet',
  rls_test.has_alert(rls_test.get('al'), 'LOW_STOCK') and rls_test.has_alert(rls_test.get('al'), 'SO_SHORTAGE') and rls_test.has_alert(rls_test.get('al'), 'AWAITING_DISPATCH')
  and rls_test.has_alert(rls_test.get('al'), 'PRODUCTION_DELAYED') and rls_test.has_alert(rls_test.get('al'), 'PAYMENT_UNALLOCATED')
  and rls_test.has_alert(rls_test.get('al'), 'INVENTORY_DISCREPANCY') and not rls_test.has_alert(rls_test.get('al'), 'INVOICE_OVERDUE')
  and not rls_test.has_alert(rls_test.get('al'), 'OUTSOURCING_OVERDUE'), left(rls_test.get('al')::text, 2000));
select rls_test.ok('alerts: stable ids, no duplicates, identical after refresh',
  rls_test.alert_ids(rls_test.get('al')) = rls_test.alert_ids(rls_test.get('al2'))
  and cardinality(rls_test.alert_ids(rls_test.get('al'))) = (select count(distinct a ->> 'id') from jsonb_array_elements(rls_test.get('al') -> 'alerts') a));
select rls_test.ok('alerts: each has severity, title, reference, detected date, explanation, action and link',
  (select bool_and(a ? 'severity' and a ? 'title' and a ? 'reference' and a ? 'detected_at' and a ? 'explanation' and a ? 'action' and (a ->> 'link') like '/%')
   from jsonb_array_elements(rls_test.get('al') -> 'alerts') a));
select rls_test.ok('alerts: SO-2 and SO-3 shortages are one alert per order', (select count(*) from jsonb_array_elements(rls_test.get('al') -> 'alerts') a where a ->> 'type' = 'SO_SHORTAGE') = 2);
select rls_test.ok('alerts: invoice due within 7 days of 27 days from now; overdue (15 days, medium) as of 45 days from now',
  rls_test.has_alert(public.analytics_alerts(rls_test.today() + 27), 'INVOICE_DUE_SOON')
  and (select a ->> 'severity' from jsonb_array_elements(public.analytics_alerts(rls_test.today() + 45) -> 'alerts') a where a ->> 'type' = 'INVOICE_OVERDUE') = 'MEDIUM');
select rls_test.claims('im');
select rls_test.ok('alerts: Inventory Manager gets no receivable or receipt alerts (permission), and is told which were skipped',
  not rls_test.has_alert(public.analytics_alerts(rls_test.today() + 45), 'INVOICE_OVERDUE') and not rls_test.has_alert(public.analytics_alerts(), 'PAYMENT_UNALLOCATED')
  and jsonb_array_length(public.analytics_alerts() -> 'skipped') >= 1);

-- ===========================================================================
-- DATA QUALITY
-- ===========================================================================
select rls_test.claims('adm');
select rls_test.expect_call_ok('data quality: Admin runs the read-only checks', 'dq', $q$ select public.analytics_data_quality() $q$);
select rls_test.ok('data quality: records created through the workflows reconcile (0 issues in 11 checks)',
  rls_test.n('dq', '{issues}') = 0 and jsonb_array_length(rls_test.get('dq') -> 'checks') = 11, left(rls_test.get('dq')::text, 2000));
reset role;
alter table public.inventory_balances disable trigger user;
update public.inventory_balances set on_hand = on_hand + 1 where product_id = rls_test.id('clay');
alter table public.inventory_balances enable trigger user;
set local role authenticated;
select rls_test.claims('adm');
select rls_test.ok('data quality: a balance that no longer matches the ledger is reported (and not corrected)',
  (select (c ->> 'issues')::int from jsonb_array_elements(public.analytics_data_quality() -> 'checks') c where c ->> 'code' = 'STOCK_LEDGER') = 1);
reset role;
alter table public.inventory_balances disable trigger user;
update public.inventory_balances set on_hand = on_hand - 1 where product_id = rls_test.id('clay');
alter table public.inventory_balances enable trigger user;
set local role authenticated;

-- ===========================================================================
-- PERMISSIONS AND ISOLATION
-- ===========================================================================
select rls_test.claims('viewer');
select rls_test.ok('viewer: read-only executive KPIs available', (public.analytics_executive(rls_test.today() - 10, rls_test.today()) #>> '{billing,available}')::boolean
  and (public.analytics_executive(rls_test.today() - 10, rls_test.today()) #>> '{sales,order_value}')::numeric = 210000);
select rls_test.expect_call_error('viewer: data quality is restricted to administrators', $q$ select public.analytics_data_quality() $q$, 'audit_logs.read');
select rls_test.ok('viewer: no export permissions', not (public.analytics_context() #>> '{export,billing}')::boolean and not (public.analytics_context() #>> '{export,sales}')::boolean);
select rls_test.claims('pur');
select rls_test.ok('Purchase Manager: sales and billing sections unavailable (no permission), inventory available',
  not (public.analytics_executive(rls_test.today() - 10, rls_test.today()) #>> '{sales,available}')::boolean
  and not (public.analytics_executive(rls_test.today() - 10, rls_test.today()) #>> '{billing,available}')::boolean
  and (public.analytics_executive(rls_test.today() - 10, rls_test.today()) #>> '{inventory,available}')::boolean
  and public.analytics_executive(rls_test.today() - 10, rls_test.today()) #> '{sales,order_value}' is null);
select rls_test.expect_call_error('Purchase Manager: sales analytics refused', format($q$ select public.analytics_sales(%L, %L) $q$, rls_test.today() - 10, rls_test.today()), 'sales_orders.read');
select rls_test.claims('im');
select rls_test.expect_call_error('Inventory Manager: financial overview refused', format($q$ select public.analytics_finance(%L, %L) $q$, rls_test.today() - 10, rls_test.today()), 'billing_reports.read');
select rls_test.claims('acc');
select rls_test.expect_call_error('Accounts Manager: shortage report refused (no shortage permission)', $q$ select public.analytics_shortages() $q$, 'customer_po_shortages.read');
select rls_test.claims('b_adm');
select rls_test.expect_call_ok('cross-company: company B executive dashboard', 'ex_b', format($q$ select public.analytics_executive(%L, %L) $q$, rls_test.today() - 10, rls_test.today()));
select rls_test.ok('cross-company: company B sees only its own data (no company A orders, invoices, stock or alerts)',
  rls_test.n('ex_b', '{sales,orders_created}') = 0 and rls_test.n('ex_b', '{billing,invoices_issued}') = 0 and rls_test.n('ex_b', '{billing,outstanding}') = 0
  and rls_test.n('ex_b', '{inventory,active_products}') = 1 and rls_test.pick(rls_test.get('ex_b') #> '{inventory,units}', 'unit', 'PCS', 'on_hand') = 3
  and not exists (select 1 from jsonb_array_elements(public.analytics_alerts() -> 'alerts') a where a ->> 'reference' like 'AN-%' or a ->> 'reference' like 'SO-%'),
  rls_test.get('ex_b')::text);
select rls_test.ok('cross-company: company B shortage, finance and data-quality results contain no company A records',
  (public.analytics_finance(rls_test.today() - 10, rls_test.today()) #>> '{totals,invoiced}')::numeric = 0
  and (public.analytics_data_quality() ->> 'issues')::int = 0
  and jsonb_array_length(public.analytics_sales(rls_test.today() - 10, rls_test.today()) -> 'top_customers_ordered') = 0);
select rls_test.ok('cross-company: a company A warehouse id passed as a filter returns nothing from company A',
  (public.analytics_executive(rls_test.today() - 10, rls_test.today(), null, rls_test.id('w1'), null) #> '{inventory,units}') = '[]'::jsonb);

-- ===========================================================================
-- READ-ONLY
-- ===========================================================================
reset role;
select rls_test.ok('read-only: no stock, reservation, order, dispatch, invoice, payment, note, production or adjustment changed while analytics ran',
  rls_test.snapshot(rls_test.id('company_a')) = rls_test.get('snap_before') and rls_test.snapshot(rls_test.id('company_b')) = rls_test.get('snap_b_before'),
  rls_test.snapshot(rls_test.id('company_a'))::text || ' vs ' || rls_test.get('snap_before')::text);

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
  raise exception 'ANALYTICS_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
