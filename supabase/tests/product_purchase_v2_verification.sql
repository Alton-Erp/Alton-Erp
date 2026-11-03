-- =============================================================================
-- PRODUCT MASTER, BOM AND PURCHASE ENHANCEMENTS VERIFICATION (ALTON ERP V2)
--
-- Checks migration 20261109090000_product_purchase_enhancements.sql:
--   * new product fields (MRP, lead time / reorder level in days, dimensions,
--     supplier model number and name): validation, trimming, grants, and that
--     the earlier quantity levels are kept untouched
--   * categories added from the product form (company scoped, unique names)
--   * day-based planning: consumption net of reversals, days of cover,
--     incoming purchase quantities, no division by zero, reorder
--     recommendation, stock status, alerts and the inventory overview
--   * supplier invoice / challan references on purchase orders and on each
--     goods receipt (atomic with the save / receipt, editable later, kept per
--     GRN, duplicate invoice numbers refused per supplier, corrections keep
--     them, lists and reports show them)
--   * company isolation, grants and the ERP reset catalogue
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction and ALWAYS ends by raising
--   PRODUCT_PURCHASE_V2_VERIFICATION_RESULT passed=N failed=M
-- so every test row is rolled back.
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
begin perform rls_test.set(p_key, r); perform rls_test.ok(p_name, not (r ? 'error'), r::text); return r; end $$;
create function rls_test.expect_call_error(p_name text, p_sql text, p_pattern text default null) returns void language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.ok(p_name, r ? 'error' and (p_pattern is null or r ->> 'error' ilike '%' || p_pattern || '%'), r::text); end $$;
create function rls_test.claims(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', rls_test.id(p_key), 'role', 'authenticated')::text, true) $$;
create function rls_test.today() returns date language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;
create function rls_test.rl(p_line uuid, p_recv numeric, p_loc uuid) returns jsonb language sql immutable as $$
  select jsonb_build_object('po_line_id', p_line, 'received_quantity', p_recv, 'accepted_quantity', p_recv, 'rejected_quantity', 0, 'accepted_location_id', p_loc) $$;
create function rls_test.add_product(p_json jsonb) returns text language sql stable as $$
  select format('insert into public.products (company_id, product_name, product_type, base_unit, %s) select %L, %L, %L, %L, %s returning jsonb_build_object(''id'', id)',
    (select string_agg(quote_ident(k), ', ') from jsonb_object_keys(p_json - 'company_id' - 'product_name' - 'product_type' - 'base_unit') k),
    p_json ->> 'company_id', p_json ->> 'product_name', coalesce(p_json ->> 'product_type', 'COMPONENT'), coalesce(p_json ->> 'base_unit', 'PCS'),
    (select string_agg(quote_nullable(v), ', ') from jsonb_each_text(p_json - 'company_id' - 'product_name' - 'product_type' - 'base_unit') e(k, v))) $$;
-- Owner-side probes (bypass RLS).
create function rls_test.product(p_id uuid) returns public.products language sql stable security definer as $$ select * from public.products where id = p_id $$;
create function rls_test.refs(p_grn uuid) returns public.purchase_document_refs language sql stable security definer as $$
  select * from public.purchase_document_refs where goods_receipt_id = p_grn $$;
create function rls_test.plan_row(p_plan jsonb, p_sku text) returns jsonb language sql immutable as $$
  select r from jsonb_array_elements(p_plan -> 'rows') r where r ->> 'sku' = p_sku $$;
create function rls_test.po_line(p_po uuid, p_no int) returns uuid language sql stable security definer as $$
  select id from public.purchase_order_lines where purchase_order_id = p_po and line_no = p_no $$;
create function rls_test.lot(p_grn uuid) returns uuid language sql stable security definer as $$
  select batch_id from public.goods_receipt_lines where goods_receipt_id = p_grn limit 1 $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5c900-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5c900-0000-4000-8000-0000000000b1'),
  ('op', 'e7e5c900-0000-4000-8000-000000000001'), ('b_op', 'e7e5c900-0000-4000-8000-000000000002'), ('viewer', 'e7e5c900-0000-4000-8000-000000000003'),
  ('s1', 'e7e5c900-0000-4000-8000-0000000000c1'), ('s2', 'e7e5c900-0000-4000-8000-0000000000c2'),
  ('cmp', 'e7e5c900-0000-4000-8000-0000000000d1'), ('fresh', 'e7e5c900-0000-4000-8000-0000000000d2'), ('plain', 'e7e5c900-0000-4000-8000-0000000000d3'),
  ('w1', 'e7e5c900-0000-4000-8000-0000000000e1'), ('wb', 'e7e5c900-0000-4000-8000-0000000000e2');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code, gstin, legal_address) values
  (rls_test.id('company_a'), 'Product Purchase V2 A Pvt Ltd', 'PP A', 'PPVA', '27AAACP1234A1Z5', 'Pune'),
  (rls_test.id('company_b'), 'Product Purchase V2 B', 'PP B', 'PPVB', null, null);
insert into auth.users (id, email) select id, key || '@ppv.example.invalid' from rls_test.ids where key in ('op', 'b_op', 'viewer');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id in (rls_test.id('op'), rls_test.id('viewer'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_op');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('op'), rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('b_op'), rls_test.id('company_b'), rls_test.id('role_super_admin')),
  (rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_management_viewer'));
insert into public.suppliers (id, company_id, supplier_code, legal_name, gstin, state_code, payment_terms, status) values
  (rls_test.id('s1'), rls_test.id('company_a'), 'PP-S1', 'Pune Brass Works', '27AAPFU0939F1ZV', '27', 'DAYS_30', 'ACTIVE'),
  (rls_test.id('s2'), rls_test.id('company_a'), 'PP-S2', 'Rajkot Castings', '24ABCDE1234F1Z5', '24', 'DAYS_30', 'ACTIVE');
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, status, hsn_code, gst_rate, standard_cost,
    reorder_level, lead_time_days, reorder_level_days) values
  (rls_test.id('cmp'), rls_test.id('company_a'), 'PP-CMP', 'Brass spindle', 'COMPONENT', 'OUTSOURCED', 'PCS', 'ACTIVE', '7412', 18, 10, null, 5, 25),
  (rls_test.id('fresh'), rls_test.id('company_a'), 'PP-NEW', 'New washer', 'COMPONENT', 'OUTSOURCED', 'PCS', 'ACTIVE', null, null, null, null, 3, 10),
  (rls_test.id('plain'), rls_test.id('company_a'), 'PP-PLAIN', 'Plain part', 'COMPONENT', 'OUTSOURCED', 'PCS', 'ACTIVE', null, null, null, null, null, null);
insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Main', true), (rls_test.id('wb'), rls_test.id('company_b'), 'W1', 'B main', true);
insert into rls_test.ids (key, id)
select case warehouse_id when rls_test.id('w1') then 'g1' else 'gb' end, id
from public.inventory_locations where location_code = 'GENERAL' and warehouse_id in (rls_test.id('w1'), rls_test.id('wb'));

-- ---------------------------------------------------------------------------
-- 1. New product fields
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('product: MRP, lead time / reorder level in days, dimensions and supplier details are saved', 'p1',
  rls_test.add_product(jsonb_build_object('company_id', rls_test.id('company_a'), 'product_name', 'Basin mixer', 'product_type', 'FINISHED_GOOD',
    'sku', 'PP-MIX', 'selling_price', '1800', 'mrp', '2499.50', 'lead_time_days', '7.5', 'reorder_level_days', '10',
    'length_cm', '32.5', 'width_cm', '18', 'height_cm', '9.25', 'supplier_model_number', '  SM-100 ', 'supplier_product_name', '  Vendor Mixer Deluxe  ')));
select rls_test.expect_call_ok('product: dimensions are optional (none given)', 'p2',
  rls_test.add_product(jsonb_build_object('company_id', rls_test.id('company_a'), 'product_name', 'No size part', 'supplier_model_number', '   ')));
select rls_test.expect_call_error('product: a negative MRP is refused',
  rls_test.add_product(jsonb_build_object('company_id', rls_test.id('company_a'), 'product_name', 'Bad MRP', 'mrp', '-1')), 'products_mrp_check');
select rls_test.expect_call_error('product: a negative lead time is refused',
  rls_test.add_product(jsonb_build_object('company_id', rls_test.id('company_a'), 'product_name', 'Bad lead', 'lead_time_days', '-2')), 'lead_time_days');
select rls_test.expect_call_error('product: a negative reorder level in days is refused',
  rls_test.add_product(jsonb_build_object('company_id', rls_test.id('company_a'), 'product_name', 'Bad days', 'reorder_level_days', '-1')), 'reorder_level_days');
select rls_test.expect_call_error('product: a zero dimension is refused (dimensions must be positive)',
  rls_test.add_product(jsonb_build_object('company_id', rls_test.id('company_a'), 'product_name', 'Flat', 'height_cm', '0')), 'products_dimensions_check');
select rls_test.expect_call_ok('product: MRP and lead time can be edited later', 'p1_edit',
  format('update public.products set mrp = 2599, lead_time_days = 8 where id = %L returning jsonb_build_object(''ok'', true)', rls_test.gid('p1', 'id')));
reset role;
select rls_test.ok('product: values stored as entered; supplier texts trimmed; blank supplier model stored as empty (NULL); MRP separate from the selling price',
  (select mrp = 2599 and selling_price = 1800 and lead_time_days = 8 and reorder_level_days = 10 and length_cm = 32.5 and width_cm = 18 and height_cm = 9.25
     and supplier_model_number = 'SM-100' and supplier_product_name = 'Vendor Mixer Deluxe' from public.products where id = rls_test.gid('p1', 'id'))
  and (select supplier_model_number is null and length_cm is null and mrp is null from public.products where id = rls_test.gid('p2', 'id')));
select rls_test.ok('product: the edit is in the audit log with the changed fields',
  exists (select 1 from public.audit_logs where resource_id = rls_test.gid('p1', 'id')::text and action = 'product.updated'
          and metadata -> 'changed_fields' ? 'mrp' and metadata -> 'changed_fields' ? 'lead_time_days'));

-- Earlier quantity levels are kept as they are (never converted).
update public.products set reorder_level = 12, minimum_level = 4 where id = rls_test.id('plain');
set local role authenticated;
select rls_test.claims('op');
select rls_test.call(format('update public.products set reorder_level_days = 15 where id = %L returning jsonb_build_object(''ok'', true)', rls_test.id('plain')));
reset role;
select rls_test.ok('product: setting a reorder level in days leaves the earlier quantity levels untouched (12 / 4)',
  (rls_test.product(rls_test.id('plain'))).reorder_level = 12 and (rls_test.product(rls_test.id('plain'))).minimum_level = 4
  and (rls_test.product(rls_test.id('plain'))).reorder_level_days = 15);
update public.products set reorder_level = null, minimum_level = null, reorder_level_days = null where id = rls_test.id('plain');

set local role authenticated;
select rls_test.claims('viewer');
select rls_test.set('viewer_upd', rls_test.call(
  format('update public.products set mrp = 1 where id = %L returning jsonb_build_object(''ok'', true)', rls_test.gid('p1', 'id'))));
reset role;
select rls_test.ok('product: a read-only user cannot change the new fields (no row updated, MRP still 2599)',
  not (rls_test.get('viewer_upd') ? 'ok') and (rls_test.product(rls_test.gid('p1', 'id'))).mrp = 2599, rls_test.get('viewer_upd')::text);
set local role authenticated;
select rls_test.claims('b_op');
select rls_test.ok('isolation: company B cannot see company A''s products or their supplier model numbers',
  not exists (select 1 from public.products where supplier_model_number = 'SM-100'));
reset role;

-- ---------------------------------------------------------------------------
-- 2. Categories added from the product form
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('category: created directly (name + description)', 'cat1',
  format('insert into public.product_categories (company_id, code, name, description) values (%L, %L, %L, %L) returning jsonb_build_object(''id'', id)',
    rls_test.id('company_a'), 'PP-TAPS', 'Bathroom Taps', 'Taps and mixers'));
select rls_test.expect_call_error('category: the same name in another letter case is refused in the same company',
  format('insert into public.product_categories (company_id, code, name) values (%L, %L, %L) returning jsonb_build_object(''id'', id)',
    rls_test.id('company_a'), 'PP-TAPS-2', 'BATHROOM TAPS'), 'product_categories_company_name_unique');
select rls_test.expect_call_ok('category: the new category can be selected on a product at once', 'p_cat',
  format('update public.products set category_id = %L where id = %L returning jsonb_build_object(''ok'', true)', rls_test.gid('cat1', 'id'), rls_test.gid('p1', 'id')));
select rls_test.claims('b_op');
select rls_test.expect_call_ok('category: another company can use the same name', 'cat_b',
  format('insert into public.product_categories (company_id, code, name) values (%L, %L, %L) returning jsonb_build_object(''id'', id)',
    rls_test.id('company_b'), 'PP-TAPS', 'Bathroom Taps'));
select rls_test.expect_call_error('category: company B cannot create a category in company A',
  format('insert into public.product_categories (company_id, code, name) values (%L, %L, %L) returning jsonb_build_object(''id'', id)',
    rls_test.id('company_a'), 'PP-X', 'Sneaky'));
select rls_test.claims('viewer');
select rls_test.expect_call_error('category: a read-only user cannot add categories',
  format('insert into public.product_categories (company_id, code, name) values (%L, %L, %L) returning jsonb_build_object(''id'', id)',
    rls_test.id('company_a'), 'PP-V', 'Viewer cat'));
reset role;

-- ---------------------------------------------------------------------------
-- 3. Day-based planning
-- Brass spindle: 100 received 30 days ago, 30 issued 20 days ago and 30 issued
-- 10 days ago -> 60 consumed over 30 days = 2 per day; 40 available = 20 days
-- of cover <= reorder level 25 days -> reorder. Lead time 5 days.
-- ---------------------------------------------------------------------------
-- Posted directly at exact times (now() is fixed within the transaction), so
-- the first movement is exactly 30 days ago.
select rls_test.set('lot', to_jsonb(private.ensure_batch(rls_test.id('company_a'), rls_test.id('cmp'), 'OUTSOURCED', null, null, null, 10,
  'TEST', null, rls_test.id('w1'), rls_test.id('g1'), false)));
select rls_test.set('rcv', to_jsonb(private.post_movement(rls_test.id('company_a'), 'RECEIPT', (rls_test.get('lot') #>> '{}')::uuid, rls_test.id('g1'), 100, 10,
  'TEST', 'RCV-1', null, 'Received for test', null, now() - interval '30 days', 'RECEIPT', null)));
select rls_test.set('iss1', to_jsonb(private.post_movement(rls_test.id('company_a'), 'ISSUE', (rls_test.get('lot') #>> '{}')::uuid, rls_test.id('g1'), 30, null,
  'TEST', 'ISS-1', null, 'Issued for test', null, now() - interval '20 days', 'ISSUE', null)));
select rls_test.set('iss2', to_jsonb(private.post_movement(rls_test.id('company_a'), 'ISSUE', (rls_test.get('lot') #>> '{}')::uuid, rls_test.id('g1'), 30, null,
  'TEST', 'ISS-2', null, 'Issued for test', null, now() - interval '10 days', 'ISSUE', null)));
select rls_test.ok('planning: fixture stock 40 after 100 in and 2 x 30 out', (select sum(on_hand) from public.inventory_balances where product_id = rls_test.id('cmp')) = 40);
-- New washer: stock but nothing ever issued.
set local role authenticated;
select rls_test.claims('op');
select rls_test.call(format('select public.goods_receipt_direct_post(%L::jsonb, %L::jsonb, %L)',
  jsonb_build_object('warehouse_id', rls_test.id('w1')),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('fresh'), 'received_quantity', 5, 'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()));
select rls_test.expect_call_ok('planning: the reorder plan runs', 'plan1', 'select public.inventory_reorder_plan(90)');
reset role;
select rls_test.ok('planning: 60 consumed over 30 days = 2/day; 40 available = 20 days of cover <= 25 -> REORDER; lead time 5 shown; suggested 2 x (5 + 25) - 40 = 20',
  (rls_test.plan_row(rls_test.get('plan1'), 'PP-CMP') ->> 'status') = 'REORDER'
  and (rls_test.plan_row(rls_test.get('plan1'), 'PP-CMP') ->> 'consumed')::numeric = 60
  and (rls_test.plan_row(rls_test.get('plan1'), 'PP-CMP') ->> 'observed_days')::int = 30
  and (rls_test.plan_row(rls_test.get('plan1'), 'PP-CMP') ->> 'avg_daily')::numeric = 2
  and (rls_test.plan_row(rls_test.get('plan1'), 'PP-CMP') ->> 'available')::numeric = 40
  and (rls_test.plan_row(rls_test.get('plan1'), 'PP-CMP') ->> 'coverage_days')::numeric = 20
  and (rls_test.plan_row(rls_test.get('plan1'), 'PP-CMP') ->> 'lead_time_days')::numeric = 5
  and (rls_test.plan_row(rls_test.get('plan1'), 'PP-CMP') ->> 'suggested_quantity')::numeric = 20,
  (rls_test.plan_row(rls_test.get('plan1'), 'PP-CMP'))::text);
select rls_test.ok('planning: no consumption -> NO_CONSUMPTION with no cover figure (no division by zero); no reorder level in days -> NOT_CONFIGURED',
  (rls_test.plan_row(rls_test.get('plan1'), 'PP-NEW') ->> 'status') = 'NO_CONSUMPTION'
  and (rls_test.plan_row(rls_test.get('plan1'), 'PP-NEW') -> 'coverage_days') = 'null'::jsonb
  and (rls_test.plan_row(rls_test.get('plan1'), 'PP-NEW') ->> 'available')::numeric = 5
  and (rls_test.plan_row(rls_test.get('plan1'), 'PP-PLAIN') ->> 'status') = 'NOT_CONFIGURED'
  and (rls_test.get('plan1') -> 'summary' ->> 'reorder')::int = 1,
  (rls_test.get('plan1') -> 'summary')::text);
select rls_test.ok('planning: the stock register status of the spindle is LOW_STOCK by days of cover; the unused washer is HEALTHY',
  (select stock_status from public.inventory_product_stock where product_id = rls_test.id('cmp')) = 'LOW_STOCK'
  and (select stock_status from public.inventory_product_stock where product_id = rls_test.id('fresh')) = 'HEALTHY');
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('planning: the inventory overview counts it as low stock', 'ov', 'select public.inventory_overview()');
select rls_test.expect_call_ok('planning: alerts are refreshed', 'al', 'select public.inventory_refresh_alerts()');
select rls_test.expect_call_error('planning: the history window is limited to 7-365 days', 'select public.inventory_reorder_plan(3)', 'between 7 and 365');
reset role;
select rls_test.ok('planning: overview low_stock = 1 and the alert carries 20 days of cover, 2/day and the lead time',
  (rls_test.get('ov') ->> 'low_stock')::int = 1
  and exists (select 1 from public.inventory_alerts where product_id = rls_test.id('cmp') and alert_type = 'LOW_STOCK' and status = 'OPEN'
              and (details ->> 'coverage_days')::numeric = 20 and (details ->> 'avg_daily')::numeric = 2 and (details ->> 'lead_time_days')::numeric = 5),
  rls_test.get('ov')::text);

-- ---------------------------------------------------------------------------
-- 4. Purchase orders with supplier invoice / challan references
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('refs: purchase order saved with supplier invoice and challan numbers in one step', 'po1',
  format('select public.purchase_order_save_refs(null, %L::jsonb, %L::jsonb, null, %L, %L::jsonb)',
    jsonb_build_object('supplier_id', rls_test.id('s1'), 'purchase_type', 'RAW_MATERIAL', 'warehouse_id', rls_test.id('w1'), 'payment_terms', 'DAYS_30'),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('cmp'), 'quantity', 15, 'unit_price', 10)), gen_random_uuid(),
    jsonb_build_object('supplier_invoice_number', ' INV-1 ', 'supplier_challan_number', 'DC-1')));
select rls_test.call(format('select public.purchase_order_open(%L)', rls_test.gid('po1', 'po_id')));
select rls_test.expect_call_ok('refs: the plan now shows 15 incoming on the open order', 'plan2', 'select public.inventory_reorder_plan(90)');
reset role;
select rls_test.ok('refs: the order list shows INV-1 / DC-1 (trimmed) next to the internal PO number; the order number is unchanged',
  (select supplier_invoice_number = 'INV-1' and supplier_challan_number = 'DC-1' and po_number ~ '^PO-[0-9]{6,}$'
   from public.purchase_order_list_v2 where id = rls_test.gid('po1', 'po_id'))
  and exists (select 1 from public.purchase_order_events where purchase_order_id = rls_test.gid('po1', 'po_id') and event_type = 'DOCUMENT_REFS_UPDATED'));
select rls_test.ok('planning: incoming 15 is shown separately and reduces the suggestion to 2 x 30 - (40 + 15) = 5; reserved shown as 0',
  (rls_test.plan_row(rls_test.get('plan2'), 'PP-CMP') ->> 'incoming')::numeric = 15
  and (rls_test.plan_row(rls_test.get('plan2'), 'PP-CMP') ->> 'reserved')::numeric = 0
  and (rls_test.plan_row(rls_test.get('plan2'), 'PP-CMP') ->> 'suggested_quantity')::numeric = 5
  and (rls_test.plan_row(rls_test.get('plan2'), 'PP-CMP') ->> 'coverage_with_incoming_days')::numeric = 27.5,
  (rls_test.plan_row(rls_test.get('plan2'), 'PP-CMP'))::text);

set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('refs: first GRN with the order''s invoice and its own challan', 'grn1',
  format('select public.purchase_receipt_post_refs(%L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('po1', 'po_id'),
    jsonb_build_object('receipt_date', rls_test.today()::text, 'supplier_invoice_number', 'INV-1', 'supplier_challan_number', 'DC-9'),
    jsonb_build_array(rls_test.rl(rls_test.po_line(rls_test.gid('po1', 'po_id'), 1), 5, rls_test.id('g1'))), gen_random_uuid()));
select rls_test.expect_call_ok('refs: second GRN on the same order with a different invoice and challan', 'grn2',
  format('select public.purchase_receipt_post_refs(%L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('po1', 'po_id'),
    jsonb_build_object('supplier_invoice_number', 'INV-2', 'supplier_challan_number', 'DC-10'),
    jsonb_build_array(rls_test.rl(rls_test.po_line(rls_test.gid('po1', 'po_id'), 1), 4, rls_test.id('g1'))), gen_random_uuid()));
reset role;
select rls_test.ok('refs: each GRN keeps its own references; the order level is unchanged; the order lists both receipt invoices',
  (rls_test.refs(rls_test.gid('grn1', 'receipt_id'))).supplier_invoice_number = 'INV-1' and (rls_test.refs(rls_test.gid('grn1', 'receipt_id'))).supplier_challan_number = 'DC-9'
  and (rls_test.refs(rls_test.gid('grn2', 'receipt_id'))).supplier_invoice_number = 'INV-2' and (rls_test.refs(rls_test.gid('grn2', 'receipt_id'))).supplier_challan_number = 'DC-10'
  and (rls_test.refs(rls_test.gid('grn2', 'receipt_id'))).supplier_id = rls_test.id('s1')
  and (rls_test.refs(rls_test.gid('grn2', 'receipt_id'))).purchase_order_id = rls_test.gid('po1', 'po_id')
  and (select supplier_invoice_number = 'INV-1' and receipt_invoice_numbers = 'INV-1, INV-2' and receipt_challan_numbers = 'DC-10, DC-9'
       from public.purchase_order_list_v2 where id = rls_test.gid('po1', 'po_id'))
  and (select supplier_invoice_number = 'INV-2' and supplier_challan_number = 'DC-10' from public.goods_receipt_list_v2 where id = rls_test.gid('grn2', 'receipt_id')));

set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('refs: the same supplier invoice (any letter case) on another order of the same supplier is refused, and nothing is saved',
  format('select public.purchase_order_save_refs(null, %L::jsonb, %L::jsonb, null, %L, %L::jsonb)',
    jsonb_build_object('supplier_id', rls_test.id('s1'), 'purchase_type', 'RAW_MATERIAL', 'warehouse_id', rls_test.id('w1'), 'payment_terms', 'DAYS_30'),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('cmp'), 'quantity', 1, 'unit_price', 10)), gen_random_uuid(),
    jsonb_build_object('supplier_invoice_number', 'inv-2')), 'already recorded');
select rls_test.expect_call_ok('refs: another supplier may use the same invoice number', 'po2',
  format('select public.purchase_order_save_refs(null, %L::jsonb, %L::jsonb, null, %L, %L::jsonb)',
    jsonb_build_object('supplier_id', rls_test.id('s2'), 'purchase_type', 'RAW_MATERIAL', 'warehouse_id', rls_test.id('w1'), 'payment_terms', 'DAYS_30'),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('cmp'), 'quantity', 1, 'unit_price', 10)), gen_random_uuid(),
    jsonb_build_object('supplier_invoice_number', 'INV-2')));
select rls_test.expect_call_error('refs: a direct GRN from the same supplier cannot reuse INV-2',
  format('select public.goods_receipt_direct_post_refs(%L::jsonb, %L::jsonb, %L)',
    jsonb_build_object('supplier_id', rls_test.id('s1'), 'warehouse_id', rls_test.id('w1'), 'supplier_invoice_number', 'INV-2'),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('fresh'), 'received_quantity', 1, 'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()), 'already recorded');
select rls_test.expect_call_ok('refs: a direct GRN with its own invoice and challan', 'd1',
  format('select public.goods_receipt_direct_post_refs(%L::jsonb, %L::jsonb, %L)',
    jsonb_build_object('supplier_id', rls_test.id('s1'), 'warehouse_id', rls_test.id('w1'), 'supplier_invoice_number', 'INV-3', 'supplier_challan_number', 'DC-11'),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('fresh'), 'received_quantity', 1, 'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()));
select rls_test.expect_call_ok('refs: the invoice of GRN 1 is entered later when it arrives (challan kept)', 'set1',
  format('select public.purchase_document_refs_set(null, %L, %L::jsonb)', rls_test.gid('grn1', 'receipt_id'), '{"supplier_invoice_number": "INV-1A"}'));
select rls_test.expect_call_ok('refs: order-level references can be updated', 'set_po',
  format('select public.purchase_document_refs_set(%L, null, %L::jsonb)', rls_test.gid('po1', 'po_id'), '{"supplier_challan_number": "DC-1B"}'));
select rls_test.expect_call_error('refs: exactly one record must be given', 'select public.purchase_document_refs_set(null, null, ''{}''::jsonb)', 'either');
reset role;
select rls_test.ok('refs: updating GRN 1 does not overwrite GRN 2; the order keeps INV-1 and gets DC-1B; the change is audited',
  (rls_test.refs(rls_test.gid('grn1', 'receipt_id'))).supplier_invoice_number = 'INV-1A' and (rls_test.refs(rls_test.gid('grn1', 'receipt_id'))).supplier_challan_number = 'DC-9'
  and (rls_test.refs(rls_test.gid('grn2', 'receipt_id'))).supplier_invoice_number = 'INV-2'
  and (select supplier_invoice_number = 'INV-1' and supplier_challan_number = 'DC-1B' from public.purchase_order_list_v2 where id = rls_test.gid('po1', 'po_id'))
  and exists (select 1 from public.audit_logs where action = 'purchase.document_refs_saved' and resource_id = rls_test.gid('grn1', 'receipt_id')::text
              and metadata ->> 'previous_invoice_number' = 'INV-1'));

-- Correction keeps the references of the receipt it replaces.
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('refs: correcting GRN 1 without new references keeps INV-1A / DC-9 on the corrected receipt', 'grn1_fix',
  format('select public.goods_receipt_correct_refs(%L, %L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('grn1', 'receipt_id'), 'Counted again', '{}',
    jsonb_build_array(rls_test.rl(rls_test.po_line(rls_test.gid('po1', 'po_id'), 1), 6, rls_test.id('g1'))), gen_random_uuid()));
select rls_test.expect_call_error('refs: a reversed receipt''s references cannot be changed',
  format('select public.purchase_document_refs_set(null, %L, %L::jsonb)', rls_test.gid('grn1', 'receipt_id'), '{"supplier_invoice_number": "X"}'), 'reversed');
reset role;
select rls_test.ok('refs: the corrected receipt carries INV-1A / DC-9; the reversed original keeps its own row',
  (rls_test.refs(rls_test.gid('grn1_fix', 'receipt_id'))).supplier_invoice_number = 'INV-1A'
  and (rls_test.refs(rls_test.gid('grn1_fix', 'receipt_id'))).supplier_challan_number = 'DC-9'
  and (rls_test.refs(rls_test.gid('grn1', 'receipt_id'))).supplier_invoice_number = 'INV-1A');

-- Reports and search.
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('reports: GRN register searched by supplier invoice number', 'r_grn',
  format('select public.erp_report_v2(%L, %L::jsonb)', 'GRN_REGISTER', '{"search": "INV-3"}'));
select rls_test.expect_call_ok('reports: purchase register', 'r_po', format('select public.erp_report_v2(%L, %L::jsonb)', 'PURCHASE_REGISTER', '{}'));
select rls_test.expect_call_ok('reports: product master report', 'r_prod', format('select public.erp_report_v2(%L, %L::jsonb)', 'PRODUCTS', '{"search": "SM-100"}'));
select rls_test.expect_call_ok('reports: reorder planning report', 'r_plan', format('select public.erp_report_v2(%L, %L::jsonb)', 'REORDER_PLANNING', '{"search": "PP-CMP"}'));
select rls_test.expect_call_ok('reports: an unchanged report still works through the new function', 'r_stock', format('select public.erp_report_v2(%L, %L::jsonb)', 'STOCK_REGISTER', '{}'));
reset role;
select rls_test.ok('reports: the GRN search finds the direct receipt by invoice INV-3 with challan DC-11',
  (rls_test.get('r_grn') ->> 'count')::int = 1 and rls_test.get('r_grn') -> 'rows' -> 0 ->> 'supplier_challan_number' = 'DC-11', rls_test.get('r_grn')::text);
select rls_test.ok('reports: the purchase register shows the order and receipt references',
  exists (select 1 from jsonb_array_elements(rls_test.get('r_po') -> 'rows') r where r ->> 'supplier_invoice_number' = 'INV-1'
          and r ->> 'supplier_challan_number' = 'DC-1B' and r ->> 'grn_invoice_numbers' like '%INV-2%'));
select rls_test.ok('reports: the product report includes MRP, lead time, reorder days, supplier model and dimensions (found by supplier model)',
  (rls_test.get('r_prod') ->> 'count')::int = 1 and (rls_test.get('r_prod') -> 'rows' -> 0 ->> 'mrp')::numeric = 2599
  and (rls_test.get('r_prod') -> 'rows' -> 0 ->> 'reorder_level_days')::numeric = 10 and (rls_test.get('r_prod') -> 'rows' -> 0 ->> 'length_cm')::numeric = 32.5,
  rls_test.get('r_prod')::text);
select rls_test.ok('reports: the reorder planning report lists the spindle as REORDER',
  (rls_test.get('r_plan') ->> 'count')::int = 1 and rls_test.get('r_plan') -> 'rows' -> 0 ->> 'status' = 'REORDER'
  and (rls_test.get('r_stock') ->> 'count')::int >= 1, rls_test.get('r_plan')::text);

-- Reversing an issue takes it out of the consumption: 30 left over 30 days =
-- 1/day; stock 40 + 6 + 4 received + 30 returned by the reversal = 80 -> 80
-- days of cover, above 25 -> OK.
select rls_test.set('rev', to_jsonb(private.reverse_ledger_transaction(rls_test.id('company_a'), (rls_test.get('iss2') #>> '{}')::uuid, 'Issued in error')));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('planning: plan after the reversal', 'plan3', 'select public.inventory_reorder_plan(90)');
reset role;
select rls_test.ok('planning: consumption is net of reversals (30 over 30 days = 1/day); 80 available = 80 days -> OK, no suggestion',
  (rls_test.plan_row(rls_test.get('plan3'), 'PP-CMP') ->> 'consumed')::numeric = 30
  and (rls_test.plan_row(rls_test.get('plan3'), 'PP-CMP') ->> 'available')::numeric = 80
  and (rls_test.plan_row(rls_test.get('plan3'), 'PP-CMP') ->> 'coverage_days')::numeric = 80
  and (rls_test.plan_row(rls_test.get('plan3'), 'PP-CMP') ->> 'status') = 'OK'
  and (rls_test.plan_row(rls_test.get('plan3'), 'PP-CMP') -> 'suggested_quantity') = 'null'::jsonb,
  (rls_test.plan_row(rls_test.get('plan3'), 'PP-CMP'))::text);

-- ---------------------------------------------------------------------------
-- 5. Company isolation, permissions and grants
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('b_op');
select rls_test.expect_call_error('isolation: company B cannot set references on company A''s order',
  format('select public.purchase_document_refs_set(%L, null, %L::jsonb)', rls_test.gid('po1', 'po_id'), '{"supplier_invoice_number": "B-1"}'), 'not found');
select rls_test.expect_call_error('isolation: ...nor on company A''s receipt',
  format('select public.purchase_document_refs_set(null, %L, %L::jsonb)', rls_test.gid('grn2', 'receipt_id'), '{"supplier_invoice_number": "B-1"}'), 'not found');
select rls_test.ok('isolation: company B sees none of company A''s references, orders or plan rows',
  not exists (select 1 from public.purchase_document_refs) and not exists (select 1 from public.purchase_order_list_v2)
  and not exists (select 1 from jsonb_array_elements((public.inventory_reorder_plan(90)) -> 'rows') r where r ->> 'sku' like 'PP-%'));
select rls_test.claims('viewer');
select rls_test.expect_call_error('permissions: a read-only user cannot set references',
  format('select public.purchase_document_refs_set(%L, null, %L::jsonb)', rls_test.gid('po1', 'po_id'), '{"supplier_invoice_number": "V-1"}'));
select rls_test.ok('permissions: a read-only user can read the references',
  exists (select 1 from public.purchase_document_refs where goods_receipt_id = rls_test.gid('grn2', 'receipt_id')));
select rls_test.expect_call_error('grants: clients cannot write the references table directly',
  format('insert into public.purchase_document_refs (company_id, purchase_order_id, supplier_invoice_number) values (%L, %L, %L) returning jsonb_build_object(''id'', id)',
    rls_test.id('company_a'), rls_test.gid('po1', 'po_id'), 'HACK'));
reset role;
select rls_test.ok('grants: anon cannot call the new functions',
  not has_function_privilege('anon', 'public.purchase_document_refs_set(uuid, uuid, jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.purchase_order_save_refs(uuid, jsonb, jsonb, timestamptz, uuid, jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.purchase_receipt_post_refs(uuid, jsonb, jsonb, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.goods_receipt_direct_post_refs(jsonb, jsonb, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.goods_receipt_correct_refs(uuid, text, jsonb, jsonb, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.inventory_reorder_plan(int)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.erp_report_v2(text, jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.save_purchase_refs(uuid, uuid, uuid, jsonb)', 'EXECUTE'));
select rls_test.ok('schema: RLS is enabled on the references table and it is in the ERP reset list before purchase orders',
  (select relrowsecurity from pg_class where oid = 'public.purchase_document_refs'::regclass)
  and (select ord from private.erp_reset_tables() where table_name = 'purchase_document_refs') < (select ord from private.erp_reset_tables() where table_name = 'goods_receipts'));

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
  raise exception 'PRODUCT_PURCHASE_V2_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
