-- =============================================================================
-- SALES ORDER VERIFICATION (ALTON ERP V2, Stage 5)
--
-- Checks migration 20261106090000_sales_orders_v2.sql end to end: numbering,
-- multi-product orders, pricing (discount % and amount, GST, intra / inter-state,
-- charges), automatic reservation of available finished goods (physical minus
-- existing reservations), BOM material calculation and reservation for the rest,
-- shared components, shortages with purchase recommendations and preferred
-- supplier, production orders from the order (linked, no duplicates), partial and
-- full dispatch, reservation release, dispatch reversal, edits with history,
-- cancellation, the Excel import (grouping, matching, duplicates on re-upload),
-- the dashboard, the stock ledger and company isolation.
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction and ALWAYS ends by raising
--   SALES_V2_VERIFICATION_RESULT passed=N failed=M
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

create function rls_test.save(p_so uuid, p_header jsonb, p_lines jsonb) returns text language sql stable as $$
  select format('select public.sales_order_v2_save(%L, %L::jsonb, %L::jsonb, %L)', p_so, p_header, p_lines, gen_random_uuid()) $$;
create function rls_test.grn(p_product uuid, p_qty numeric, p_cost numeric) returns text language sql stable as $$
  select format('select public.goods_receipt_direct_post(%L::jsonb, %L::jsonb, %L)',
    jsonb_build_object('warehouse_id', rls_test.id('w1')),
    jsonb_build_array(jsonb_build_object('product_id', p_product, 'received_quantity', p_qty, 'accepted_quantity', p_qty, 'unit_cost', p_cost,
      'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()) $$;
create function rls_test.dispatch(p_so uuid, p_line uuid, p_qty numeric) returns text language sql stable as $$
  select format('select public.sales_order_v2_dispatch(%L, %L::jsonb, %L::jsonb, %L)', p_so,
    jsonb_build_array(jsonb_build_object('line_id', p_line, 'quantity', p_qty)), jsonb_build_object('vehicle_number', 'MH12AB1234'), gen_random_uuid()) $$;
create function rls_test.l(p_summary jsonb, p_sku text) returns jsonb language sql immutable as $$
  select l from jsonb_array_elements(p_summary -> 'lines') l where l ->> 'sku' = p_sku limit 1 $$;
create function rls_test.s(p_summary jsonb, p_sku text) returns jsonb language sql immutable as $$
  select s from jsonb_array_elements(p_summary -> 'shortages') s where s ->> 'sku' = p_sku limit 1 $$;

-- Owner-side probes (bypass RLS).
create function rls_test.so(p_id uuid) returns public.sales_orders language sql stable security definer as $$ select * from public.sales_orders where id = p_id $$;
create function rls_test.sol(p_so uuid, p_product uuid) returns public.sales_order_lines language sql stable security definer as $$
  select * from public.sales_order_lines where sales_order_id = p_so and product_id = p_product order by line_no limit 1 $$;
create function rls_test.on_hand(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(on_hand), 0) from public.inventory_balances where product_id = p_product $$;
create function rls_test.reserved(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(reserved), 0) from public.inventory_balances where product_id = p_product $$;
create function rls_test.res_line(p_line uuid, p_type text, p_product uuid default null) returns numeric language sql stable security definer as $$
  select coalesce(sum(quantity - fulfilled_quantity - released_quantity), 0) from public.stock_reservations
  where reference_id = p_line and reference_type = p_type and (p_product is null or product_id = p_product) and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') $$;
create function rls_test.tx_count(p_company uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.inventory_transactions where company_id = p_company $$;
create function rls_test.so_count(p_company uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.sales_orders where company_id = p_company $$;
create function rls_test.prod_for(p_line uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.production_orders where sales_order_line_id = p_line $$;
create function rls_test.prod_id(p_line uuid) returns uuid language sql stable security definer as $$
  select id from public.production_orders where sales_order_line_id = p_line order by created_at limit 1 $$;
create function rls_test.events(p_so uuid) returns text[] language sql stable security definer as $$
  select array_agg(event_type order by created_at, id) from public.sales_order_events where sales_order_id = p_so $$;
create function rls_test.last_edit(p_so uuid) returns public.sales_order_events language sql stable security definer as $$
  select * from public.sales_order_events where sales_order_id = p_so and event_type = 'EDITED' order by created_at desc, id desc limit 1 $$;
create function rls_test.fulfilment(p_so uuid, p_n int) returns public.fulfilments language sql stable security definer as $$
  select * from public.fulfilments where sales_order_id = p_so order by created_at, fulfilment_number offset p_n - 1 limit 1 $$;
create function rls_test.ledger_consistent(p_company uuid) returns boolean language sql stable security definer as $$
  select not exists (
    select 1 from public.inventory_balances b
    where b.company_id = p_company
      and (b.on_hand <> coalesce((select sum(t.direction * t.quantity) from public.inventory_transactions t where t.batch_id = b.batch_id and t.location_id = b.location_id), 0)
           or b.reserved <> coalesce((select sum(r.quantity - r.fulfilled_quantity - r.released_quantity) from public.stock_reservations r
                                      where r.batch_id = b.batch_id and r.location_id = b.location_id and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')), 0)
           or b.reserved > b.on_hand)) $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5c600-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5c600-0000-4000-8000-0000000000b1'),
  ('op', 'e7e5c600-0000-4000-8000-000000000001'), ('b_op', 'e7e5c600-0000-4000-8000-000000000002'),
  ('cx', 'e7e5c600-0000-4000-8000-0000000000c1'), ('cy', 'e7e5c600-0000-4000-8000-0000000000c2'), ('sup', 'e7e5c600-0000-4000-8000-0000000000c3'),
  ('a', 'e7e5c600-0000-4000-8000-0000000000d1'), ('b', 'e7e5c600-0000-4000-8000-0000000000d2'), ('c', 'e7e5c600-0000-4000-8000-0000000000d3'),
  ('cmp', 'e7e5c600-0000-4000-8000-0000000000d4'), ('rm', 'e7e5c600-0000-4000-8000-0000000000d5'),
  ('w1', 'e7e5c600-0000-4000-8000-0000000000e1'), ('wb', 'e7e5c600-0000-4000-8000-0000000000e2');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code, gstin, legal_address) values
  (rls_test.id('company_a'), 'Sales V2 A Pvt Ltd', 'Sales A', 'SVA', '27AAACS9876A1Z5', 'Pune'),
  (rls_test.id('company_b'), 'Sales V2 B', 'Sales B', 'SVB', null, null);
insert into auth.users (id, email) select id, key || '@sv.example.invalid' from rls_test.ids where key in ('op', 'b_op');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = rls_test.id('op');
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_op');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('op'), rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('b_op'), rls_test.id('company_b'), rls_test.id('role_super_admin'));
insert into public.customers (id, company_id, customer_code, customer_name, status, gstin, billing_state_code, billing_address) values
  (rls_test.id('cx'), rls_test.id('company_a'), 'CUS-X', 'Xylo Homes', 'ACTIVE', '27AABCX1234A1Z5', '27', 'Pune'),
  (rls_test.id('cy'), rls_test.id('company_a'), 'CUS-Y', 'Yamuna Builders', 'ACTIVE', '24AABCY1234A1Z5', '24', 'Ahmedabad');
insert into public.suppliers (id, company_id, supplier_code, legal_name, status) values
  (rls_test.id('sup'), rls_test.id('company_a'), 'S-RM', 'Clay Suppliers', 'ACTIVE');
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, track_batches, track_expiry, status,
  selling_price, gst_rate, standard_cost, preferred_supplier_id) values
  (rls_test.id('a'),   rls_test.id('company_a'), 'SV-A', 'Product A', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, 'ACTIVE', 1000, 18, null, null),
  (rls_test.id('b'),   rls_test.id('company_a'), 'SV-B', 'Product B', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, 'ACTIVE', 500, 12, null, null),
  (rls_test.id('c'),   rls_test.id('company_a'), 'SV-C', 'Product C', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, 'ACTIVE', 100, 5, null, null),
  (rls_test.id('cmp'), rls_test.id('company_a'), 'SV-CMP', 'Shared component', 'COMPONENT', 'IN_HOUSE', 'PCS', false, false, 'ACTIVE', null, 18, 10, null),
  (rls_test.id('rm'),  rls_test.id('company_a'), 'SV-RM', 'Raw material', 'RAW_MATERIAL', 'OUTSOURCED', 'KG', false, false, 'ACTIVE', null, 5, 20, rls_test.id('sup'));
insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Main', true), (rls_test.id('wb'), rls_test.id('company_b'), 'W1', 'B main', true);
insert into rls_test.ids (key, id)
select case warehouse_id when rls_test.id('w1') then 'g1' else 'gb' end, id
from public.inventory_locations where location_code = 'GENERAL' and warehouse_id in (rls_test.id('w1'), rls_test.id('wb'));

set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('setup: 40 Product A in stock', 'g1', rls_test.grn(rls_test.id('a'), 40, 600));
select rls_test.expect_call_ok('setup: 100 shared components', 'g2', rls_test.grn(rls_test.id('cmp'), 100, 10));
select rls_test.expect_call_ok('setup: 20 KG raw material', 'g3', rls_test.grn(rls_test.id('rm'), 20, 20));
select rls_test.expect_call_ok('setup: BOM of A (1 component + 0.5 KG raw material)', 'ba',
  format('select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, %L)', rls_test.id('a'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('cmp'), 'quantity_required', 1),
                      jsonb_build_object('component_product_id', rls_test.id('rm'), 'quantity_required', 0.5)), gen_random_uuid()));
select rls_test.expect_call_ok('setup: activate it', 'baa', format('select public.production_bom_activate(%L, null)', rls_test.gid('ba', 'bom_id')));
select rls_test.expect_call_ok('setup: BOM of B (2 of the same component)', 'bb',
  format('select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, %L)', rls_test.id('b'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('cmp'), 'quantity_required', 2)), gen_random_uuid()));
select rls_test.expect_call_ok('setup: activate it', 'bba', format('select public.production_bom_activate(%L, null)', rls_test.gid('bb', 'bom_id')));
-- An existing order holds 10 of the 40 Product A.
select rls_test.expect_call_ok('existing reservation: an earlier order for 10 Product A', 'so0',
  rls_test.save(null, jsonb_build_object('customer_id', rls_test.id('cx'), 'customer_po_number', 'OLD-1'),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('a'), 'quantity', 10))));
reset role;
select rls_test.set('tx0', to_jsonb(rls_test.tx_count(rls_test.id('company_a'))));
select rls_test.ok('existing reservation: 10 of 40 Product A reserved; order READY_FOR_DISPATCH; nothing moved',
  rls_test.reserved(rls_test.id('a')) = 10 and rls_test.on_hand(rls_test.id('a')) = 40 and rls_test.get('so0') ->> 'status' = 'READY_FOR_DISPATCH', rls_test.get('so0')::text);

-- ---------------------------------------------------------------------------
-- 1. Multi-product order: pricing, numbering, automatic reservations
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('create: order for A 100 (10% off), B 50 (500 off), C 200; freight 1000, other 200', 'so1',
  rls_test.save(null, jsonb_build_object('customer_id', rls_test.id('cx'), 'customer_reference', 'PO-778', 'payment_terms', '30 days',
      'delivery_instructions', 'Gate 2', 'freight_amount', 1000, 'other_charges_amount', 200, 'internal_notes', 'First big order'),
    jsonb_build_array(
      jsonb_build_object('product_id', rls_test.id('a'), 'quantity', 100, 'unit_price', 1000, 'discount_percent', 10),
      jsonb_build_object('product_id', rls_test.id('b'), 'quantity', 50, 'discount_amount', 500),
      jsonb_build_object('product_id', rls_test.id('c'), 'quantity', 200))));
reset role;
select rls_test.set('so1id', to_jsonb(rls_test.gid('so1', 'sales_order_id')));
select rls_test.ok('numbering: automatic SO number, different from the first order',
  rls_test.get('so1') ->> 'sales_order_number' like 'SO-%' and rls_test.get('so1') ->> 'sales_order_number' <> rls_test.get('so0') ->> 'sales_order_number');
select rls_test.ok('customer: GSTIN and the header fields are kept on the order',
  (rls_test.so(rls_test.gid('so1', 'sales_order_id'))).customer_gstin_snapshot = '27AABCX1234A1Z5'
  and (rls_test.so(rls_test.gid('so1', 'sales_order_id'))).payment_terms = '30 days'
  and (rls_test.so(rls_test.gid('so1', 'sales_order_id'))).delivery_instructions = 'Gate 2');
select rls_test.ok('price: A 100 x 1000 - 10% = 90000 + 18% = 106200; B 50 x 500 (from the product) - 500 = 24500 + 12% = 27440; C 20000 + 5% = 21000',
  (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('a'))).line_total = 106200
  and (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('b'))).taxable_value = 24500
  and (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('b'))).line_total = 27440
  and (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('c'))).line_total = 21000);
select rls_test.ok('totals: gross 145000, discount 10500, taxable 135700 (incl. 1200 charges), CGST = SGST 10178, grand total 156056 (intra-state)',
  (rls_test.so(rls_test.gid('so1', 'sales_order_id'))).gross_total = 145000 and (rls_test.so(rls_test.gid('so1', 'sales_order_id'))).discount_total = 10500
  and (rls_test.so(rls_test.gid('so1', 'sales_order_id'))).taxable_total = 135700 and (rls_test.so(rls_test.gid('so1', 'sales_order_id'))).cgst_total = 10178
  and (rls_test.so(rls_test.gid('so1', 'sales_order_id'))).sgst_total = 10178 and (rls_test.so(rls_test.gid('so1', 'sales_order_id'))).igst_total = 0
  and (rls_test.so(rls_test.gid('so1', 'sales_order_id'))).grand_total = 156056, to_jsonb(rls_test.so(rls_test.gid('so1', 'sales_order_id')))::text);
select rls_test.ok('finished goods: available = 40 physical - 10 already reserved = 30, so 30 reserved and 70 left to produce',
  (rls_test.l(rls_test.get('so1'), 'SV-A') ->> 'reserved')::numeric = 30 and (rls_test.l(rls_test.get('so1'), 'SV-A') ->> 'to_produce')::numeric = 70
  and rls_test.reserved(rls_test.id('a')) = 40, rls_test.l(rls_test.get('so1'), 'SV-A')::text);
select rls_test.ok('BOM: for 70 A — 70 components and 35 KG raw material; 20 KG reserved (all there is)',
  (select (m ->> 'required')::numeric = 70 and (m ->> 'reserved')::numeric = 70 from jsonb_array_elements(rls_test.l(rls_test.get('so1'), 'SV-A') -> 'materials') m where m ->> 'sku' = 'SV-CMP')
  and (select (m ->> 'required')::numeric = 35 and (m ->> 'reserved')::numeric = 20 from jsonb_array_elements(rls_test.l(rls_test.get('so1'), 'SV-A') -> 'materials') m where m ->> 'sku' = 'SV-RM'));
select rls_test.ok('shared component: B needs 100 but only 30 are left after A took 70 — reserved 30, never more than the 100 in stock',
  (select (m ->> 'reserved')::numeric = 30 and (m ->> 'required')::numeric = 100 from jsonb_array_elements(rls_test.l(rls_test.get('so1'), 'SV-B') -> 'materials') m where m ->> 'sku' = 'SV-CMP')
  and rls_test.reserved(rls_test.id('cmp')) = 100);
select rls_test.ok('shortages: component short 70, raw material short 15 KG with its preferred supplier and recommended purchase',
  (rls_test.s(rls_test.get('so1'), 'SV-CMP') ->> 'shortage')::numeric = 70 and (rls_test.s(rls_test.get('so1'), 'SV-CMP') ->> 'recommended_purchase')::numeric = 70
  and (rls_test.s(rls_test.get('so1'), 'SV-RM') ->> 'shortage')::numeric = 15 and rls_test.s(rls_test.get('so1'), 'SV-RM') ->> 'preferred_supplier_name' = 'Clay Suppliers',
  (rls_test.get('so1') -> 'shortages')::text);
select rls_test.ok('no BOM: C is flagged (200 to produce, the product has no active BOM); status STOCK_SHORTAGE; warnings do not block',
  (rls_test.l(rls_test.get('so1'), 'SV-C') ->> 'to_produce')::numeric = 200 and (rls_test.l(rls_test.get('so1'), 'SV-C') ->> 'material_short')::boolean
  and rls_test.get('so1') ->> 'status' = 'STOCK_SHORTAGE' and (rls_test.get('so1') -> 'warnings')::text ilike '%no active BOM%');
select rls_test.ok('stock: the order moved nothing (no ledger entries, on hand unchanged)',
  rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx0'))::bigint and rls_test.on_hand(rls_test.id('a')) = 40 and rls_test.on_hand(rls_test.id('cmp')) = 100);

set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('inter-state: an order for the Gujarat customer', 'so2',
  rls_test.save(null, jsonb_build_object('customer_id', rls_test.id('cy')), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('a'), 'quantity', 5))));
select rls_test.expect_call_ok('recalculate: order 1 again', 'so1r', format('select public.sales_order_v2_reserve(%L)', rls_test.gid('so1', 'sales_order_id')));
reset role;
select rls_test.ok('inter-state: 5 x 1000 + 18% IGST = 5900, no CGST / SGST; nothing to reserve (all A taken), shortage shown',
  (rls_test.so(rls_test.gid('so2', 'sales_order_id'))).igst_total = 900 and (rls_test.so(rls_test.gid('so2', 'sales_order_id'))).cgst_total = 0
  and (rls_test.so(rls_test.gid('so2', 'sales_order_id'))).grand_total = 5900 and (rls_test.l(rls_test.get('so2'), 'SV-A') ->> 'reserved')::numeric = 0);
select rls_test.ok('no double reservation: recalculating changes nothing (A 40, components 100, raw 20 reserved in total)',
  rls_test.reserved(rls_test.id('a')) = 40 and rls_test.reserved(rls_test.id('cmp')) = 100 and rls_test.reserved(rls_test.id('rm')) = 20
  and (rls_test.l(rls_test.get('so1r'), 'SV-A') ->> 'reserved')::numeric = 30 and rls_test.ledger_consistent(rls_test.id('company_a')));

-- ---------------------------------------------------------------------------
-- 2. Production orders from the sales order
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('production: create production orders for order 1', 'pr1',
  format('select public.sales_order_v2_create_production(%L, null, %L)', rls_test.gid('so1', 'sales_order_id'), gen_random_uuid()));
select rls_test.expect_call_ok('production: asking again', 'pr2',
  format('select public.sales_order_v2_create_production(%L, null, %L)', rls_test.gid('so1', 'sales_order_id'), gen_random_uuid()));
select rls_test.expect_call_ok('production: summary after', 'so1p', format('select public.sales_order_v2_summary(%L)', rls_test.gid('so1', 'sales_order_id')));
reset role;
select rls_test.ok('production: A 70 and B 50 ordered with the active BOMs, linked to the lines; C skipped (no BOM)',
  jsonb_array_length(rls_test.get('pr1') -> 'created') = 2 and jsonb_array_length(rls_test.get('pr1') -> 'skipped') = 1
  and (select (c ->> 'quantity')::numeric = 70 from jsonb_array_elements(rls_test.get('pr1') -> 'created') c where c ->> 'sku' = 'SV-A')
  and rls_test.prod_for((rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('a'))).id) = 1, rls_test.get('pr1')::text);
select rls_test.ok('production: no duplicates — the second request creates nothing',
  jsonb_array_length(rls_test.get('pr2') -> 'created') = 0 and rls_test.prod_for((rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('a'))).id) = 1
  and rls_test.prod_for((rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('b'))).id) = 1, rls_test.get('pr2')::text);
select rls_test.ok('production: materials handed over, not reserved twice — order lines hold none, production orders hold 70 + 30 components and 20 KG',
  rls_test.res_line((rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('a'))).id, 'SALES_ORDER_MATERIAL') = 0
  and rls_test.res_line((rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('b'))).id, 'SALES_ORDER_MATERIAL') = 0
  and rls_test.reserved(rls_test.id('cmp')) = 100 and rls_test.reserved(rls_test.id('rm')) = 20
  and (rls_test.l(rls_test.get('so1p'), 'SV-A') ->> 'production_open')::numeric = 70 and (rls_test.l(rls_test.get('so1p'), 'SV-A') ->> 'to_produce')::numeric = 0);
select rls_test.ok('stock: creating production orders deducted nothing', rls_test.on_hand(rls_test.id('cmp')) = 100 and rls_test.on_hand(rls_test.id('rm')) = 20);

-- Produce A (receive the missing raw material first), then reserve the new stock for the order.
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('setup: receive 15 KG raw material', 'g4', rls_test.grn(rls_test.id('rm'), 15, 20));
select rls_test.expect_call_ok('production: complete the A order (70 made)', 'pc',
  format('select public.production_order_v2_complete(%L, %L::jsonb, %L)', rls_test.prod_id((rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('a'))).id),
    jsonb_build_object('actual_quantity', 70), gen_random_uuid()));
select rls_test.expect_call_ok('recalculate after production', 'so1q', format('select public.sales_order_v2_reserve(%L)', rls_test.gid('so1', 'sales_order_id')));
reset role;
select rls_test.ok('production: the 70 made are reserved for the order — A fully covered (100 reserved), produced 70',
  (rls_test.l(rls_test.get('so1q'), 'SV-A') ->> 'reserved')::numeric = 100 and (rls_test.l(rls_test.get('so1q'), 'SV-A') ->> 'produced')::numeric = 70
  and rls_test.on_hand(rls_test.id('a')) = 110 and rls_test.reserved(rls_test.id('a')) = 110);

-- ---------------------------------------------------------------------------
-- 3. Dispatch: 30 + 40 + 30, reversal
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('dispatch 1: 30 A', 'd1', rls_test.dispatch(rls_test.gid('so1', 'sales_order_id'), (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('a'))).id, 30));
reset role;
select rls_test.ok('dispatch 1: stock 110 -> 80, reservation 110 -> 80, line dispatched 30, status PARTIALLY_DISPATCHED',
  rls_test.on_hand(rls_test.id('a')) = 80 and rls_test.reserved(rls_test.id('a')) = 80
  and (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('a'))).quantity_dispatched = 30 and rls_test.get('d1') ->> 'status' = 'PARTIALLY_DISPATCHED',
  rls_test.get('d1')::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('dispatch 2: 40 A', 'd2', rls_test.dispatch(rls_test.gid('so1', 'sales_order_id'), (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('a'))).id, 40));
select rls_test.expect_call_ok('dispatch 3: the last 30 A', 'd3', rls_test.dispatch(rls_test.gid('so1', 'sales_order_id'), (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('a'))).id, 30));
select rls_test.expect_call_error('dispatch: more than ordered is refused',
  rls_test.dispatch(rls_test.gid('so1', 'sales_order_id'), (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('a'))).id, 1), 'still to dispatch');
select rls_test.expect_call_error('dispatch: B has no stock — refused, nothing posted',
  rls_test.dispatch(rls_test.gid('so1', 'sales_order_id'), (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('b'))).id, 5), 'short');
reset role;
select rls_test.ok('dispatch: three separate consignments; A fully dispatched (100); stock 110 - 100 = 10 left, reserved for the old order',
  (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('a'))).quantity_dispatched = 100 and (rls_test.fulfilment(rls_test.gid('so1', 'sales_order_id'), 3)).fulfilment_status = 'DISPATCHED'
  and rls_test.on_hand(rls_test.id('a')) = 10 and rls_test.reserved(rls_test.id('a')) = 10
  and (select count(*) from public.fulfilments where sales_order_id = rls_test.gid('so1', 'sales_order_id') and fulfilment_status = 'DISPATCHED') = 3);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('reverse: the third dispatch was wrong', 'rv',
  format('select public.sales_order_v2_reverse_dispatch(%L, %L, %L)', (rls_test.fulfilment(rls_test.gid('so1', 'sales_order_id'), 3)).id, 'Truck returned to the factory', gen_random_uuid()));
select rls_test.expect_call_error('reverse: the same consignment cannot be reversed twice',
  format('select public.sales_order_v2_reverse_dispatch(%L, %L, %L)', (rls_test.fulfilment(rls_test.gid('so1', 'sales_order_id'), 3)).id, 'Again please', gen_random_uuid()), 'is cancelled');
reset role;
select rls_test.ok('reverse: 30 back in stock (reversal entry, original kept) and reserved for the order again; dispatched 70; history recorded',
  rls_test.on_hand(rls_test.id('a')) = 40 and rls_test.reserved(rls_test.id('a')) = 40
  and (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('a'))).quantity_dispatched = 70
  and rls_test.res_line((rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('a'))).id, 'SALES_ORDER_LINE') = 30
  and (rls_test.fulfilment(rls_test.gid('so1', 'sales_order_id'), 3)).fulfilment_status = 'CANCELLED'
  and 'DISPATCH_REVERSED' = any(rls_test.events(rls_test.gid('so1', 'sales_order_id'))) and jsonb_array_length(rls_test.get('rv') -> 'reversal_numbers') = 1);
select rls_test.ok('ledger: balances and reservations equal the ledger after dispatches and the reversal', rls_test.ledger_consistent(rls_test.id('company_a')));

-- ---------------------------------------------------------------------------
-- 4. Corrections, release, cancellation
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('edit: after a dispatch a reason is required',
  rls_test.save(rls_test.gid('so1', 'sales_order_id'), '{}'::jsonb, jsonb_build_array(
    jsonb_build_object('line_id', (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('a'))).id, 'product_id', rls_test.id('a'), 'quantity', 100, 'unit_price', 1000, 'discount_percent', 10))),
  'reason for the correction');
select rls_test.expect_call_error('edit: quantity below what was dispatched is refused',
  rls_test.save(rls_test.gid('so1', 'sales_order_id'), jsonb_build_object('correction_reason', 'Customer reduced the order'), jsonb_build_array(
    jsonb_build_object('line_id', (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('a'))).id, 'product_id', rls_test.id('a'), 'quantity', 50))),
  'cannot go below 70');
select rls_test.expect_call_ok('edit: B down to 40, A price unchanged, C removed, new expected date', 'e1',
  rls_test.save(rls_test.gid('so1', 'sales_order_id'), jsonb_build_object('correction_reason', 'Customer revised PO-778', 'requested_delivery_date', (rls_test.today() + 20)::text),
    jsonb_build_array(
      jsonb_build_object('line_id', (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('a'))).id, 'product_id', rls_test.id('a'), 'quantity', 100, 'unit_price', 1000, 'discount_percent', 10),
      jsonb_build_object('line_id', (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('b'))).id, 'product_id', rls_test.id('b'), 'quantity', 40, 'discount_amount', 500))));
reset role;
select rls_test.ok('edit: B is 40, C cancelled (history kept), totals recalculated; history shows previous / new values and the reason',
  (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('b'))).quantity_ordered - (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('b'))).quantity_cancelled = 40
  and (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('c'))).line_status = 'CANCELLED'
  and (rls_test.so(rls_test.gid('so1', 'sales_order_id'))).grand_total < 156056
  and (rls_test.last_edit(rls_test.gid('so1', 'sales_order_id'))).note = 'Customer revised PO-778'
  and (rls_test.last_edit(rls_test.gid('so1', 'sales_order_id'))).details -> 'changes' @> '[{"field": "quantity", "old": 50, "new": 40}]'::jsonb,
  (rls_test.last_edit(rls_test.gid('so1', 'sales_order_id'))).details::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('release: order 1 reservations released', 'rl', format('select public.sales_order_v2_release(%L, %L)', rls_test.gid('so1', 'sales_order_id'), 'Re-plan'));
select rls_test.expect_call_ok('cancel: the old order', 'cx0', format('select public.sales_order_v2_cancel(%L, %L, %L)', rls_test.gid('so0', 'sales_order_id'), 'Customer cancelled', gen_random_uuid()));
reset role;
select rls_test.ok('release: the 30 A held for order 1 are free again (only the old order''s 10 remain before it is cancelled)',
  (rls_test.get('rl') ->> 'finished_goods_released')::numeric = 30);
select rls_test.ok('cancel: the old order is cancelled and its 10 A released; nothing of A is reserved now; stock unchanged',
  rls_test.get('cx0') ->> 'status' = 'CANCELLED' and rls_test.reserved(rls_test.id('a')) = 0 and rls_test.on_hand(rls_test.id('a')) = 40);

-- ---------------------------------------------------------------------------
-- 5. Excel import (grouping, matching, errors, no duplicates on re-upload)
-- ---------------------------------------------------------------------------
select rls_test.set('rows', jsonb_build_array(
  jsonb_build_object('row_number', 2, 'order_date', rls_test.today()::text, 'customer_name', 'xylo homes', 'customer_reference', 'CPO-1', 'sku', 'sv-a', 'quantity', '2', 'selling_price', '1000'),
  jsonb_build_object('row_number', 3, 'order_date', rls_test.today()::text, 'customer_name', 'Xylo Homes', 'customer_reference', 'CPO-1', 'sku', 'SV-B', 'quantity', '1'),
  jsonb_build_object('row_number', 4, 'order_date', rls_test.today()::text, 'customer_name', 'Nobody Ltd', 'customer_reference', 'N-1', 'sku', 'SV-A', 'quantity', '1'),
  jsonb_build_object('row_number', 5, 'order_date', rls_test.today()::text, 'customer_gstin', '27AABCX1234A1Z5', 'customer_reference', 'CPO-2', 'sku', 'NOPE', 'quantity', '1'),
  jsonb_build_object('row_number', 6, 'order_date', rls_test.today()::text, 'customer_name', 'Xylo Homes', 'customer_reference', 'CPO-3', 'sku', 'SV-A', 'quantity', '1.5'),
  jsonb_build_object('row_number', 7, 'order_date', rls_test.today()::text, 'customer_name', 'Xylo Homes', 'customer_reference', 'CPO-4', 'sku', 'SV-A', 'quantity', '1',
    'selling_price', '1000', 'discount', '10%', 'gst_rate', '18')));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('import: preview', 'ip', format('select public.sales_order_import_preview(%L::jsonb, null)', rls_test.get('rows')));
reset role;
select rls_test.ok('import: rows grouped by customer + reference into 5 orders; CPO-1 has 2 lines; customers matched by name or GSTIN, products by SKU',
  jsonb_array_length(rls_test.get('ip') -> 'orders') = 5
  and (select jsonb_array_length(g -> 'rows') = 2 and g ->> 'status' <> 'ERROR' from jsonb_array_elements(rls_test.get('ip') -> 'orders') g where g ->> 'customer_reference' = 'CPO-1')
  and (select g ->> 'status' = 'ERROR' from jsonb_array_elements(rls_test.get('ip') -> 'orders') g where g ->> 'customer_reference' = 'CPO-2'),
  rls_test.get('ip')::text);
select rls_test.ok('import: missing customer and product listed for Quick Add; bad quantity reported; total of CPO-4 = 1000 - 10% + 18% = 1062',
  (rls_test.get('ip') -> 'missing_customers')::text ilike '%Nobody Ltd%' and (rls_test.get('ip') -> 'missing_products')::text ilike '%NOPE%'
  and (rls_test.get('ip') -> 'orders')::text ilike '%whole pieces%' and (rls_test.get('ip') ->> 'errors')::int = 3
  and (select (g ->> 'estimated_total')::numeric = 1062 from jsonb_array_elements(rls_test.get('ip') -> 'orders') g where g ->> 'customer_reference' = 'CPO-4'));
select rls_test.set('so_n', to_jsonb(rls_test.so_count(rls_test.id('company_a'))));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('import: import the valid orders', 'im',
  format('select public.sales_order_import(%L::jsonb, null, %L::jsonb, %L)', rls_test.get('rows'), jsonb_build_object('file_name', 'orders.xlsx'), gen_random_uuid()));
select rls_test.expect_call_ok('import: the same file again', 'im2',
  format('select public.sales_order_import(%L::jsonb, null, %L::jsonb, %L)', rls_test.get('rows'), jsonb_build_object('file_name', 'orders.xlsx'), gen_random_uuid()));
reset role;
select rls_test.ok('import: 2 orders created (CPO-1 with 2 lines, CPO-4); 3 held back with their messages; recorded in Bulk Operations',
  (rls_test.get('im') ->> 'created_count')::int = 2 and (rls_test.get('im') ->> 'failed_count')::int = 3
  and rls_test.so_count(rls_test.id('company_a')) = (rls_test.get('so_n'))::bigint + 2
  and exists (select 1 from public.import_jobs where id = rls_test.gid('im', 'job_id') and import_type = 'SALES_ORDER' and success_rows = 3 and failed_rows = 3),
  rls_test.get('im')::text);
select rls_test.ok('import: re-uploading creates no duplicate orders (both reported as already imported)',
  (rls_test.get('im2') ->> 'created_count')::int = 0 and rls_test.so_count(rls_test.id('company_a')) = (rls_test.get('so_n'))::bigint + 2
  and (rls_test.get('im2') -> 'failed')::text ilike '%Already imported%');

-- ---------------------------------------------------------------------------
-- 6. Dashboard, isolation, grants
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('dashboard', 'db', format('select public.sales_dashboard(%L, %L, null, null)', rls_test.today() - 30, rls_test.today()));
select rls_test.expect_call_ok('dashboard: customer filter', 'dby', format('select public.sales_dashboard(%L, %L, %L, null)', rls_test.today() - 30, rls_test.today(), rls_test.id('cy')));
select rls_test.expect_call_ok('register: filtered by status', 'lst', format('select public.sales_orders_v2_list(null, null, null, %L)', 'CANCELLED'));
reset role;
select rls_test.ok('dashboard: 5 orders, 1 cancelled, 1 partially dispatched, value excludes the cancelled order; quantities per unit',
  (rls_test.get('db') ->> 'total_orders')::int = 5 and (rls_test.get('db') ->> 'cancelled')::int = 1 and (rls_test.get('db') ->> 'partially_fulfilled')::int = 1
  and (rls_test.get('db') ->> 'created_today')::int = 5 and jsonb_array_length(rls_test.get('db') -> 'recent') = 5
  and (rls_test.get('db') -> 'ordered') @> '[{"unit": "PCS"}]'::jsonb, rls_test.get('db')::text);
select rls_test.ok('dashboard: shortages include the shared component; production required shown per unit',
  exists (select 1 from jsonb_array_elements(rls_test.get('db') -> 'shortages') s where s ->> 'sku' = 'SV-CMP')
  and jsonb_array_length(rls_test.get('db') -> 'production_required') >= 1);
select rls_test.ok('filters: the Gujarat customer has 1 order; the status filter lists only cancelled orders',
  (rls_test.get('dby') ->> 'total_orders')::int = 1 and jsonb_array_length(rls_test.get('lst')) = 1 and rls_test.get('lst') -> 0 ->> 'status' = 'CANCELLED');
select rls_test.ok('ledger: still consistent, never more reserved than on hand', rls_test.ledger_consistent(rls_test.id('company_a')));

set local role authenticated;
select rls_test.claims('b_op');
select rls_test.expect_call_error('isolation: company B cannot read company A''s order', format('select public.sales_order_v2_summary(%L)', rls_test.gid('so1', 'sales_order_id')), 'not found');
select rls_test.expect_call_error('isolation: nor dispatch it',
  rls_test.dispatch(rls_test.gid('so1', 'sales_order_id'), (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('a'))).id, 1), 'not found');
select rls_test.expect_call_ok('isolation: company B dashboard', 'dbb', format('select public.sales_dashboard(%L, %L, null, null)', rls_test.today() - 30, rls_test.today()));
reset role;
select rls_test.ok('isolation: company B sees no orders', (rls_test.get('dbb') ->> 'total_orders')::int = 0);
select rls_test.ok('grants: anon cannot call the sales order functions',
  not has_function_privilege('anon', 'public.sales_order_v2_save(uuid, jsonb, jsonb, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.sales_order_v2_dispatch(uuid, jsonb, jsonb, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.sales_order_import(jsonb, uuid, jsonb, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.sales_dashboard(date, date, uuid, text)', 'EXECUTE'));

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
  raise exception 'SALES_V2_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
