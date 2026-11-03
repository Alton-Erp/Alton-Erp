-- =============================================================================
-- END-TO-END VERIFICATION (ALTON ERP V2, Stage 7)
--
-- Runs the whole single-operator business flow through the same database
-- functions the screens call, then checks stock, ledgers, invoices, the
-- management overview, module dashboards, reports, reconciliation, settings,
-- global search and the activity centre (migration 20261108090000_management_v2.sql).
--
--  1-4   products (automatic SKUs), BOM, supplier
--  5-7   purchase order (no stock), goods received (stock and payable)
--  8-11  production order (reserves, no deduction), completion (deducts, adds)
--  12-15 customer, sales orders (finished goods reserved; rest to produce)
--  16-17 dispatch (stock deducted, reservation used)
--  18-22 invoice, partial and final payment, ledger, PAID
--  23    dashboards and reports; cancellation, correction, reversal, duplicates
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Always ends with STAGE7_E2E_VERIFICATION_RESULT passed=N failed=M (rolled back).
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

-- Owner-side probes (bypass RLS)
create function rls_test.on_hand(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(on_hand), 0) from public.inventory_balances where product_id = p_product $$;
create function rls_test.reserved(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(reserved), 0) from public.inventory_balances where product_id = p_product $$;
create function rls_test.prod(p_id uuid) returns public.products language sql stable security definer as $$ select * from public.products where id = p_id $$;
create function rls_test.po_line(p_po uuid, p_product uuid) returns uuid language sql stable security definer as $$
  select id from public.purchase_order_lines where purchase_order_id = p_po and product_id = p_product $$;
create function rls_test.po(p_id uuid) returns public.purchase_orders language sql stable security definer as $$ select * from public.purchase_orders where id = p_id $$;
create function rls_test.sol(p_so uuid) returns uuid language sql stable security definer as $$
  select id from public.sales_order_lines where sales_order_id = p_so order by line_no limit 1 $$;
create function rls_test.inv(p_id uuid) returns jsonb language sql stable security definer as $$ select to_jsonb(l) from public.sales_invoice_list l where id = p_id $$;
create function rls_test.party_bal(p_party uuid) returns jsonb language sql stable security definer as $$
  select to_jsonb(b) from private.party_balances((select company_id from public.parties where id = p_party)) b where b.party_id = p_party $$;
create function rls_test.tx_count(p_company uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.inventory_transactions where company_id = p_company $$;
create function rls_test.res_count(p_company uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.stock_reservations where company_id = p_company $$;
create function rls_test.so_count(p_company uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.sales_orders where company_id = p_company $$;
create function rls_test.check_issues(p_rec jsonb, p_code text) returns int language sql immutable as $$
  select (c ->> 'issues')::int from jsonb_array_elements(p_rec -> 'checks') c where c ->> 'code' = p_code $$;
create function rls_test.alert(p_ov jsonb, p_code text) returns jsonb language sql immutable as $$
  select a from jsonb_array_elements(p_ov -> 'alerts') a where a ->> 'code' = p_code $$;
create function rls_test.uq(p_list jsonb, p_unit text) returns numeric language sql immutable as $$
  select case when jsonb_typeof(p_list) = 'array' then coalesce((select (u ->> 'quantity')::numeric from jsonb_array_elements(p_list) u where u ->> 'unit' = p_unit), 0) end $$;
create function rls_test.report(p_name text, p_filters jsonb default '{}'::jsonb) returns text language sql stable as $$
  select format('select public.erp_report(%L, %L::jsonb)', p_name, p_filters) $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures: two companies, one operator each; warehouses only (everything else
-- is created through the flow)
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5c800-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5c800-0000-4000-8000-0000000000b1'),
  ('op', 'e7e5c800-0000-4000-8000-000000000001'), ('b_op', 'e7e5c800-0000-4000-8000-000000000002'),
  ('w1', 'e7e5c800-0000-4000-8000-0000000000e1'), ('wb', 'e7e5c800-0000-4000-8000-0000000000e2');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;
insert into public.companies (id, legal_name, display_name, company_code, gstin, legal_address) values
  (rls_test.id('company_a'), 'Alton E2E Sanitary Pvt Ltd', 'Alton E2E', 'E7A', '27AAACE7777A1Z5', 'MIDC, Pune'),
  (rls_test.id('company_b'), 'Empty Co', 'Empty Co', 'E7B', null, null);
insert into auth.users (id, email) select id, key || '@e7.example.invalid' from rls_test.ids where key in ('op', 'b_op');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = rls_test.id('op');
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_op');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('op'), rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('b_op'), rls_test.id('company_b'), rls_test.id('role_super_admin'));
insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Main', true), (rls_test.id('wb'), rls_test.id('company_b'), 'W1', 'B main', true);
insert into rls_test.ids (key, id)
select case warehouse_id when rls_test.id('w1') then 'g1' else 'gb' end, id
from public.inventory_locations where location_code = 'GENERAL' and warehouse_id in (rls_test.id('w1'), rls_test.id('wb'));

-- ---------------------------------------------------------------------------
-- Steps 1-2: products created by the operator (blank SKU -> automatic SKU)
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, track_batches, track_expiry, status, hsn_code, gst_rate, selling_price, standard_cost) values
  (rls_test.id('company_a'), null, 'E2E Wash Basin', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, 'ACTIVE', '69101000', 18, 1000, null),
  (rls_test.id('company_a'), null, 'E2E Ball Clay', 'RAW_MATERIAL', 'OUTSOURCED', 'KG', false, false, 'ACTIVE', '2508', 5, null, 20),
  (rls_test.id('company_a'), null, 'E2E Waste Coupling', 'OUTSOURCED_COMPONENT', 'OUTSOURCED', 'PCS', false, false, 'ACTIVE', '3922', 18, null, 50);
reset role;
insert into rls_test.ids (key, id) select case product_name when 'E2E Wash Basin' then 'fg' when 'E2E Ball Clay' then 'clay' else 'cpl' end, id
from public.products where company_id = rls_test.id('company_a');
select rls_test.ok('step 1-2: products created with automatic SKUs per type (FG-, RM-, OSC-)',
  (rls_test.prod(rls_test.id('fg'))).sku = 'FG-000001' and (rls_test.prod(rls_test.id('clay'))).sku = 'RM-000001' and (rls_test.prod(rls_test.id('cpl'))).sku = 'OSC-000001',
  (rls_test.prod(rls_test.id('fg'))).sku);

-- Step 3: BOM (2.5 KG clay + 1 coupling per basin)
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('step 3: BOM saved', 'bom', format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$,
  rls_test.id('fg'), rls_test.today(), jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('clay'), 'quantity_required', 2.5),
    jsonb_build_object('component_product_id', rls_test.id('cpl'), 'quantity_required', 1))));
select rls_test.expect_call_ok('step 3: BOM activated', 'boma', format('select public.production_bom_activate(%L)', rls_test.gid('bom', 'bom_id')));

-- Step 4: supplier (ledger party)
select rls_test.expect_call_ok('step 4: supplier created', 'sup', format('select public.party_save(null, %L::jsonb, false, %L)',
  jsonb_build_object('party_type', 'SUPPLIER', 'party_name', 'Morbi Clay Traders', 'gstin', '27AABCM1234A1Z5', 'billing_address', 'Morbi', 'state_code', '27',
    'credit_period_days', 30), gen_random_uuid()));

-- Step 5: purchase order (100 KG clay @ 20 + 5%; 40 couplings @ 50 + 18%) = 2100 + 2360 = 4460
select rls_test.expect_call_ok('step 5: purchase order created', 'po', format('select public.purchase_order_save(null, %L::jsonb, %L::jsonb, null, %L)',
  jsonb_build_object('supplier_id', rls_test.gid('sup', 'supplier_id'), 'purchase_type', 'RAW_MATERIAL', 'warehouse_id', rls_test.id('w1'),
    'expected_delivery_date', rls_test.today() + 7),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('clay'), 'quantity', 100, 'unit_price', 20),
                    jsonb_build_object('product_id', rls_test.id('cpl'), 'quantity', 40, 'unit_price', 50)), gen_random_uuid()));
select rls_test.expect_call_ok('step 5: purchase order opened (one step, no approval)', 'poo', format('select public.purchase_order_open(%L)', rls_test.gid('po', 'po_id')));
reset role;
select rls_test.ok('step 5: PO total 4460; number PO-000001; creating it moved no stock',
  (rls_test.po(rls_test.gid('po', 'po_id'))).grand_total = 4460 and (rls_test.po(rls_test.gid('po', 'po_id'))).po_number = 'PO-000001'
  and rls_test.tx_count(rls_test.id('company_a')) = 0 and rls_test.on_hand(rls_test.id('clay')) = 0, to_jsonb(rls_test.po(rls_test.gid('po', 'po_id')))::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('step 5: overview before receipt', 'ov0', format('select public.management_overview(%L, %L)', rls_test.today() - 30, rls_test.today()));
reset role;
select rls_test.ok('step 5: the PO is incoming stock (100 KG, 40 PCS), not physical stock; no payable yet',
  rls_test.uq(rls_test.get('ov0') -> 'inventory' -> 'incoming', 'KG') = 100 and rls_test.uq(rls_test.get('ov0') -> 'inventory' -> 'incoming', 'PCS') = 40
  and rls_test.uq(rls_test.get('ov0') -> 'inventory' -> 'physical', 'KG') = 0 and (rls_test.get('ov0') -> 'kpis' ->> 'payables')::numeric = 0,
  (rls_test.get('ov0') -> 'inventory')::text);

-- Step 6-7: goods received
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('step 6: goods received in full', 'grn', format('select public.purchase_receipt_post(%L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('po', 'po_id'),
  jsonb_build_object('receipt_date', rls_test.today()::text),
  jsonb_build_array(
    jsonb_build_object('po_line_id', rls_test.po_line(rls_test.gid('po', 'po_id'), rls_test.id('clay')), 'received_quantity', 100, 'accepted_quantity', 100, 'rejected_quantity', 0, 'accepted_location_id', rls_test.id('g1')),
    jsonb_build_object('po_line_id', rls_test.po_line(rls_test.gid('po', 'po_id'), rls_test.id('cpl')), 'received_quantity', 40, 'accepted_quantity', 40, 'rejected_quantity', 0, 'accepted_location_id', rls_test.id('g1'))),
  gen_random_uuid()));
reset role;
select rls_test.ok('step 7: inventory increased (100 KG clay, 40 couplings); PO received; supplier payable 4460',
  rls_test.on_hand(rls_test.id('clay')) = 100 and rls_test.on_hand(rls_test.id('cpl')) = 40 and (rls_test.po(rls_test.gid('po', 'po_id'))).status = 'RECEIVED'
  and (rls_test.party_bal(rls_test.gid('sup', 'party_id')) ->> 'payable')::numeric = 4460, rls_test.party_bal(rls_test.gid('sup', 'party_id'))::text);

-- Step 8-9: production order for 20 basins
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('step 8: production order created', 'pr', format('select public.production_order_v2_save(null, %L::jsonb, %L)',
  jsonb_build_object('product_id', rls_test.id('fg'), 'planned_quantity', 20, 'production_date', rls_test.today()), gen_random_uuid()));
reset role;
select rls_test.ok('step 9: BOM calculation reserves 50 KG clay and 20 couplings; physical stock unchanged',
  rls_test.reserved(rls_test.id('clay')) = 50 and rls_test.reserved(rls_test.id('cpl')) = 20 and rls_test.on_hand(rls_test.id('clay')) = 100 and rls_test.on_hand(rls_test.id('cpl')) = 40,
  rls_test.get('pr')::text);

-- Step 10-11: complete production
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('step 10: production completed (20 made)', 'prc', format('select public.production_order_v2_complete(%L, %L::jsonb, %L)',
  rls_test.gid('pr', 'order_id'), jsonb_build_object('actual_quantity', 20, 'production_date', rls_test.today()), gen_random_uuid()));
select rls_test.expect_call_error('duplicate: completing the same order again is refused', format('select public.production_order_v2_complete(%L, %L::jsonb, %L)',
  rls_test.gid('pr', 'order_id'), jsonb_build_object('actual_quantity', 20), gen_random_uuid()), 'cannot be completed');
reset role;
select rls_test.ok('step 11: materials deducted (50 KG clay, 20 couplings), 20 basins added, reservations used up',
  rls_test.on_hand(rls_test.id('clay')) = 50 and rls_test.on_hand(rls_test.id('cpl')) = 20 and rls_test.on_hand(rls_test.id('fg')) = 20
  and rls_test.reserved(rls_test.id('clay')) = 0 and rls_test.reserved(rls_test.id('cpl')) = 0);

-- Step 12: customer
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('step 12: customer created', 'cus', format('select public.party_save(null, %L::jsonb, false, %L)',
  jsonb_build_object('party_type', 'CUSTOMER', 'party_name', 'Pune Homes LLP', 'gstin', '27AAPFP1234B1Z2', 'gst_registration_type', 'REGISTERED',
    'billing_address', 'Baner, Pune', 'state_code', '27', 'credit_period_days', 15), gen_random_uuid()));

-- Step 13-15: sales orders (12 from stock; 15 more: 8 left in stock, 7 to produce)
select rls_test.set('so1_key', to_jsonb(gen_random_uuid()));
select rls_test.expect_call_ok('step 13: sales order for 12 basins', 'so1', format('select public.sales_order_v2_save(null, %L::jsonb, %L::jsonb, %L)',
  jsonb_build_object('customer_id', rls_test.gid('cus', 'customer_id'), 'customer_po_number', 'PH-101'),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('fg'), 'quantity', 12)), rls_test.get('so1_key') #>> '{}'));
reset role;
select rls_test.set('so_n', to_jsonb(rls_test.so_count(rls_test.id('company_a'))));
select rls_test.set('res_n', to_jsonb(rls_test.res_count(rls_test.id('company_a'))));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('duplicate: the same request again returns the same order', 'so1b', format('select public.sales_order_v2_save(null, %L::jsonb, %L::jsonb, %L)',
  jsonb_build_object('customer_id', rls_test.gid('cus', 'customer_id'), 'customer_po_number', 'PH-101'),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('fg'), 'quantity', 12)), rls_test.get('so1_key') #>> '{}'));
reset role;
select rls_test.ok('duplicate: no second order and no second reservation',
  rls_test.gid('so1b', 'sales_order_id') = rls_test.gid('so1', 'sales_order_id') and rls_test.so_count(rls_test.id('company_a')) = (rls_test.get('so_n') #>> '{}')::bigint
  and rls_test.res_count(rls_test.id('company_a')) = (rls_test.get('res_n') #>> '{}')::bigint);
select rls_test.ok('step 14: 12 finished goods reserved, 8 available; order ready for dispatch',
  rls_test.reserved(rls_test.id('fg')) = 12 and rls_test.on_hand(rls_test.id('fg')) = 20 and rls_test.get('so1') ->> 'status' = 'READY_FOR_DISPATCH', rls_test.get('so1')::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('step 15: second sales order for 15 basins', 'so2', format('select public.sales_order_v2_save(null, %L::jsonb, %L::jsonb, %L)',
  jsonb_build_object('customer_id', rls_test.gid('cus', 'customer_id'), 'customer_po_number', 'PH-102'),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('fg'), 'quantity', 15)), gen_random_uuid()));
reset role;
select rls_test.ok('step 15: only the 8 available are reserved (partially reserved); 7 to produce; materials for 7 (17.5 KG clay, 7 couplings) reserved',
  rls_test.reserved(rls_test.id('fg')) = 20 and (rls_test.get('so2') -> 'lines' -> 0 ->> 'reserved')::numeric = 8
  and (rls_test.get('so2') -> 'lines' -> 0 ->> 'to_produce')::numeric = 7 and rls_test.reserved(rls_test.id('clay')) = 17.5 and rls_test.reserved(rls_test.id('cpl')) = 7
  and rls_test.get('so2') ->> 'status' = 'PARTIALLY_RESERVED', rls_test.get('so2')::text);

-- Step 16-17: dispatch order 1
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('step 16: 12 basins dispatched', 'dsp', format('select public.sales_order_v2_dispatch(%L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('so1', 'sales_order_id'),
  jsonb_build_array(jsonb_build_object('line_id', rls_test.sol(rls_test.gid('so1', 'sales_order_id')), 'quantity', 12)), jsonb_build_object('vehicle_number', 'MH12AB1234'), gen_random_uuid()));
reset role;
select rls_test.ok('step 17: physical stock 8, reservation of order 1 used (only order 2 holds 8); order fully dispatched',
  rls_test.on_hand(rls_test.id('fg')) = 8 and rls_test.reserved(rls_test.id('fg')) = 8 and rls_test.get('dsp') ->> 'status' = 'FULLY_DISPATCHED', rls_test.get('dsp')::text);

-- Step 18: invoice for the 12 dispatched (12 x 1000 + 18% = 14160), issued in one step
select rls_test.set('tx_before_inv', to_jsonb(rls_test.tx_count(rls_test.id('company_a'))));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('step 18: invoice drafted from the sales order', 'inv', format('select public.sales_invoice_v2_save(null, %L::jsonb, %L::jsonb, null, %L)',
  jsonb_build_object('sales_order_id', rls_test.gid('so1', 'sales_order_id')),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('fg'), 'sales_order_line_id', rls_test.sol(rls_test.gid('so1', 'sales_order_id')), 'quantity', 12)), gen_random_uuid()));
select rls_test.expect_call_ok('step 18: invoice issued', 'invi', format('select public.sales_invoice_v2_issue(%L, false, %L)', rls_test.gid('inv', 'invoice_id'), gen_random_uuid()));
select rls_test.expect_call_error('duplicate: the dispatched order cannot be invoiced twice', format('select public.sales_invoice_v2_save(null, %L::jsonb, %L::jsonb, null, %L)',
  jsonb_build_object('sales_order_id', rls_test.gid('so1', 'sales_order_id')),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('fg'), 'sales_order_line_id', rls_test.sol(rls_test.gid('so1', 'sales_order_id')), 'quantity', 1)), gen_random_uuid()), 'only 0');
reset role;
select rls_test.ok('step 18: invoice 14160 (CGST + SGST), no stock moved by invoicing',
  (rls_test.inv(rls_test.gid('inv', 'invoice_id')) ->> 'grand_total')::numeric = 14160 and (rls_test.inv(rls_test.gid('inv', 'invoice_id')) ->> 'cgst_total')::numeric = 1080
  and rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx_before_inv') #>> '{}')::bigint and rls_test.on_hand(rls_test.id('fg')) = 8,
  rls_test.inv(rls_test.gid('inv', 'invoice_id'))::text);

-- Step 19-20: partial payment and the customer ledger
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('step 19: partial payment 5000', 'pay1', format('select public.invoice_v2_record_payment(%L, %L::jsonb, %L)', rls_test.gid('inv', 'invoice_id'),
  jsonb_build_object('amount', 5000, 'payment_method', 'UPI', 'transaction_reference', 'UPI-1'), gen_random_uuid()));
select rls_test.expect_call_error('duplicate: the same payment reference is refused', format('select public.invoice_v2_record_payment(%L, %L::jsonb, %L)', rls_test.gid('inv', 'invoice_id'),
  jsonb_build_object('amount', 5000, 'payment_method', 'UPI', 'transaction_reference', 'UPI-1'), gen_random_uuid()), 'already recorded');
reset role;
select rls_test.ok('step 20: invoice partially paid, outstanding 9160; customer ledger 14160 - 5000 = 9160',
  rls_test.inv(rls_test.gid('inv', 'invoice_id')) ->> 'payment_status' = 'PARTIALLY_PAID' and (rls_test.inv(rls_test.gid('inv', 'invoice_id')) ->> 'balance_due')::numeric = 9160
  and (rls_test.party_bal(rls_test.gid('cus', 'party_id')) ->> 'receivable')::numeric = 9160
  and (rls_test.party_bal(rls_test.gid('cus', 'party_id')) ->> 'invoice_outstanding')::numeric = 9160, rls_test.party_bal(rls_test.gid('cus', 'party_id'))::text);

-- Step 21-22: final payment
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('step 21: remaining 9160 paid', 'pay2', format('select public.invoice_v2_record_payment(%L, %L::jsonb, %L)', rls_test.gid('inv', 'invoice_id'),
  jsonb_build_object('amount', 9160, 'payment_method', 'BANK_TRANSFER', 'transaction_reference', 'UTR-2'), gen_random_uuid()));
reset role;
select rls_test.ok('step 22: invoice PAID, balance 0; customer ledger 0',
  rls_test.inv(rls_test.gid('inv', 'invoice_id')) ->> 'payment_status' = 'PAID' and (rls_test.inv(rls_test.gid('inv', 'invoice_id')) ->> 'balance_due')::numeric = 0
  and (rls_test.party_bal(rls_test.gid('cus', 'party_id')) ->> 'receivable')::numeric = 0);

-- ---------------------------------------------------------------------------
-- Step 23: management overview, module dashboards, reports, reconciliation
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('step 23: management overview', 'ov', format('select public.management_overview(%L, %L)', rls_test.today() - 30, rls_test.today()));
reset role;
select rls_test.ok('overview KPIs: invoiced 14160 vs order value 31860 (kept apart); received 14160; purchases received 4460; production 20 PCS',
  (rls_test.get('ov') -> 'kpis' ->> 'sales_invoiced')::numeric = 14160 and (rls_test.get('ov') -> 'kpis' ->> 'sales_order_value')::numeric = 31860
  and (rls_test.get('ov') -> 'kpis' ->> 'receipts')::numeric = 14160 and (rls_test.get('ov') -> 'kpis' ->> 'purchase_received')::numeric = 4460
  and (rls_test.get('ov') -> 'kpis' ->> 'purchase_ordered')::numeric = 4460 and rls_test.uq(rls_test.get('ov') -> 'kpis' -> 'production', 'PCS') = 20
  and (rls_test.get('ov') -> 'kpis' ->> 'invoices')::int = 1, (rls_test.get('ov') -> 'kpis')::text);
select rls_test.ok('overview KPIs: receivables and customer outstanding 0; payables and supplier outstanding 4460 (from GRN, not the PO)',
  (rls_test.get('ov') -> 'kpis' ->> 'receivables')::numeric = 0 and (rls_test.get('ov') -> 'kpis' ->> 'customer_outstanding')::numeric = 0
  and (rls_test.get('ov') -> 'kpis' ->> 'payables')::numeric = 4460 and (rls_test.get('ov') -> 'kpis' ->> 'supplier_outstanding')::numeric = 4460);
select rls_test.ok('overview inventory per unit (never summed across units): FG 8 PCS, RM 50 KG, outsourced components 20 PCS; reserved and available',
  rls_test.uq(rls_test.get('ov') -> 'inventory' -> 'finished_goods', 'PCS') = 8 and rls_test.uq(rls_test.get('ov') -> 'inventory' -> 'raw_materials', 'KG') = 50
  and rls_test.uq(rls_test.get('ov') -> 'inventory' -> 'outsourced_components', 'PCS') = 20
  and rls_test.uq(rls_test.get('ov') -> 'inventory' -> 'physical', 'PCS') = 28 and rls_test.uq(rls_test.get('ov') -> 'inventory' -> 'reserved', 'PCS') = 15
  and rls_test.uq(rls_test.get('ov') -> 'inventory' -> 'available_stock', 'PCS') = 13 and rls_test.uq(rls_test.get('ov') -> 'inventory' -> 'available_stock', 'KG') = 32.5
  and rls_test.uq(rls_test.get('ov') -> 'inventory' -> 'incoming', 'KG') = 0, (rls_test.get('ov') -> 'inventory')::text);
select rls_test.ok('overview valuation from lot costs: raw material 50 KG x 20 = 1000; finished goods valued; total covers all lots',
  (rls_test.get('ov') -> 'kpis' ->> 'raw_material_value')::numeric = 1000 and (rls_test.get('ov') -> 'kpis' ->> 'finished_goods_value')::numeric > 0
  and (rls_test.get('ov') -> 'kpis' ->> 'uncosted_lots')::int = 0
  and (rls_test.get('ov') -> 'kpis' ->> 'inventory_value')::numeric = (rls_test.get('ov') -> 'kpis' ->> 'raw_material_value')::numeric
     + (rls_test.get('ov') -> 'kpis' ->> 'finished_goods_value')::numeric + 20 * 50, (rls_test.get('ov') -> 'kpis')::text);
select rls_test.ok('overview sections: purchase (1 created, 1 completed), production (20 good), sales (1 dispatch, 1 order needs production), invoicing (paid 1)',
  (rls_test.get('ov') -> 'purchase' ->> 'created')::int = 1 and (rls_test.get('ov') -> 'purchase' ->> 'completed')::int = 1
  and (rls_test.get('ov') -> 'purchase' ->> 'available')::boolean
  and (rls_test.get('ov') -> 'production' -> 'by_product' -> 0 ->> 'good')::numeric = 20 and (rls_test.get('ov') -> 'production' -> 'by_product' -> 0 ->> 'yield_percent')::numeric = 100
  and (rls_test.get('ov') -> 'sales' ->> 'dispatches')::int = 1 and (rls_test.get('ov') -> 'sales' ->> 'orders_requiring_production')::int = 1
  and (rls_test.get('ov') -> 'invoicing' ->> 'fully_paid')::int = 1 and jsonb_array_length(rls_test.get('ov') -> 'sales' -> 'monthly') = 12,
  (rls_test.get('ov') - 'inventory' - 'alerts')::text);
select rls_test.ok('alerts: all 12 alert types present, each with a link; missing-info alert lists nothing for complete products',
  jsonb_array_length(rls_test.get('ov') -> 'alerts') = 12 and not exists (select 1 from jsonb_array_elements(rls_test.get('ov') -> 'alerts') a where coalesce(a ->> 'link', '') = '')
  and (rls_test.alert(rls_test.get('ov'), 'MISSING_BOM') ->> 'count')::int = 0 and (rls_test.alert(rls_test.get('ov'), 'SUPPLIER_PAYMENT_PENDING') ->> 'count')::int = 1
  and rls_test.alert(rls_test.get('ov'), 'SUPPLIER_PAYMENT_PENDING') -> 'items' -> 0 ->> 'link' = '/ledger/' || rls_test.gid('sup', 'party_id'),
  (rls_test.get('ov') -> 'alerts')::text);

set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('module dashboard: products', 'mdp', format('select public.module_dashboard(''PRODUCTS'', %L, %L)', rls_test.today() - 30, rls_test.today()));
select rls_test.expect_call_ok('module dashboard: ledger', 'mdl', format('select public.module_dashboard(''LEDGER'', %L, %L)', rls_test.today() - 30, rls_test.today()));
select rls_test.expect_call_ok('module dashboard: purchase', 'mdpo', format('select public.module_dashboard(''PURCHASE'', %L, %L)', rls_test.today() - 30, rls_test.today()));
select rls_test.expect_call_ok('module dashboard: goods received', 'mdg', format('select public.module_dashboard(''GRN'', %L, %L)', rls_test.today() - 30, rls_test.today()));
select rls_test.expect_call_error('module dashboard: unknown module', format('select public.module_dashboard(''NOPE'', %L, %L)', rls_test.today(), rls_test.today()), 'Unknown dashboard');
reset role;
select rls_test.ok('module dashboards: 3 products (1 FG, 1 RM, 1 outsourced), 1 customer + 1 supplier, payables 4460, 1 PO fully received, 1 GRN today',
  (rls_test.get('mdp') ->> 'total')::int = 3 and (rls_test.get('mdp') ->> 'finished_goods')::int = 1 and (rls_test.get('mdp') ->> 'raw_materials')::int = 1
  and (rls_test.get('mdp') ->> 'without_bom')::int = 0
  and (rls_test.get('mdl') ->> 'customers')::int = 1 and (rls_test.get('mdl') ->> 'suppliers')::int = 1 and (rls_test.get('mdl') ->> 'payables')::numeric = 4460
  and (rls_test.get('mdpo') ->> 'fully_received')::int = 1 and (rls_test.get('mdg') ->> 'today')::int = 1 and (rls_test.get('mdg') ->> 'unlinked')::int = 0,
  rls_test.get('mdl')::text);

set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('reports: invoice register', 'r_inv', rls_test.report('INVOICE_REGISTER'));
select rls_test.expect_call_ok('reports: GRN register', 'r_grn', rls_test.report('GRN_REGISTER'));
select rls_test.expect_call_ok('reports: production register', 'r_prd', rls_test.report('PRODUCTION_REGISTER'));
select rls_test.expect_call_ok('reports: payment collection', 'r_pay', rls_test.report('PAYMENT_COLLECTION'));
select rls_test.expect_call_ok('reports: stock register', 'r_stk', rls_test.report('STOCK_REGISTER'));
select rls_test.expect_call_ok('reports: GST summary', 'r_gst', rls_test.report('GST_SUMMARY'));
select rls_test.expect_call_ok('reports: supplier outstanding', 'r_so', rls_test.report('SUPPLIER_OUTSTANDING'));
select rls_test.expect_call_ok('reports: product-wise sales', 'r_ps', rls_test.report('PRODUCT_SALES'));
select rls_test.expect_call_ok('reports: material consumption filtered by the clay', 'r_mc', rls_test.report('MATERIAL_CONSUMPTION', jsonb_build_object('product_id', rls_test.id('clay'))));
select rls_test.expect_call_ok('reports: search "pune" in the sales order register', 'r_sor', rls_test.report('SALES_ORDER_REGISTER', '{"search": "pune"}'));
select rls_test.expect_call_ok('reports: date filter outside the activity', 'r_old', rls_test.report('INVOICE_REGISTER', jsonb_build_object('from', '2020-01-01', 'to', '2020-12-31')));
select rls_test.expect_call_error('reports: unknown report', rls_test.report('NOPE'), 'Unknown report');
select rls_test.set('all_reports', (select jsonb_object_agg(r, rls_test.call(rls_test.report(r))) from unnest(array['PRODUCTS', 'STOCK_REGISTER', 'STOCK_MOVEMENTS',
  'INVENTORY_VALUATION', 'LOW_STOCK', 'PURCHASE_REGISTER', 'GRN_REGISTER', 'SUPPLIER_PURCHASES', 'PRODUCTION_REGISTER', 'MATERIAL_CONSUMPTION', 'PRODUCTION_WASTAGE',
  'SALES_ORDER_REGISTER', 'CUSTOMER_SALES', 'PRODUCT_SALES', 'DISPATCH', 'INVOICE_REGISTER', 'GST_SUMMARY', 'CUSTOMER_OUTSTANDING', 'SUPPLIER_OUTSTANDING', 'PAYMENT_COLLECTION']) r));
reset role;
select rls_test.ok('reports: all 20 run without error',
  (select count(*) from jsonb_each(rls_test.get('all_reports')) e where not (e.value ? 'error')) = 20, rls_test.get('all_reports')::text);
select rls_test.ok('reports: invoice 14160 paid; 2 GRN lines worth 4460; 20 produced; 2 receipts = 14160; FG on hand 8',
  (rls_test.get('r_inv') ->> 'count')::int = 1 and (rls_test.get('r_inv') -> 'rows' -> 0 ->> 'grand_total')::numeric = 14160
  and (rls_test.get('r_inv') -> 'rows' -> 0 ->> 'status') = 'PAID'
  and (rls_test.get('r_grn') ->> 'count')::int = 2 and (select sum((r ->> 'value')::numeric) from jsonb_array_elements(rls_test.get('r_grn') -> 'rows') r) = 4460
  and (rls_test.get('r_prd') -> 'rows' -> 0 ->> 'good')::numeric = 20
  and (select sum((r ->> 'amount')::numeric) from jsonb_array_elements(rls_test.get('r_pay') -> 'rows') r) = 14160
  and (select (r ->> 'on_hand')::numeric from jsonb_array_elements(rls_test.get('r_stk') -> 'rows') r where r ->> 'sku' = 'FG-000001') = 8, rls_test.get('r_grn')::text);
select rls_test.ok('reports: GST 12000 taxable at 18%; supplier outstanding 4460; product sales 27 ordered / 12 dispatched / 12 invoiced',
  (select (r ->> 'taxable')::numeric from jsonb_array_elements(rls_test.get('r_gst') -> 'rows') r where (r ->> 'gst_rate')::numeric = 18) = 12000
  and (rls_test.get('r_so') -> 'rows' -> 0 ->> 'payable')::numeric = 4460
  and (select (r ->> 'ordered')::numeric from jsonb_array_elements(rls_test.get('r_ps') -> 'rows') r where r ->> 'sku' = 'FG-000001') = 27
  and (select (r ->> 'dispatched')::numeric from jsonb_array_elements(rls_test.get('r_ps') -> 'rows') r where r ->> 'sku' = 'FG-000001') = 12
  and (select (r ->> 'invoiced')::numeric from jsonb_array_elements(rls_test.get('r_ps') -> 'rows') r where r ->> 'sku' = 'FG-000001') = 12,
  rls_test.get('r_ps')::text);
select rls_test.ok('reports: product filter (clay only, 50 KG consumed), search (2 orders for Pune Homes), date filter (none in 2020)',
  (rls_test.get('r_mc') ->> 'count')::int = 1 and (rls_test.get('r_mc') -> 'rows' -> 0 ->> 'actual')::numeric = 50
  and (rls_test.get('r_sor') ->> 'count')::int = 2 and (rls_test.get('r_old') ->> 'count')::int = 0, rls_test.get('r_mc')::text);

set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('reconciliation', 'rec', 'select public.erp_reconciliation()');
reset role;
select rls_test.ok('reconciliation: every inventory and finance check passes after the full flow',
  (rls_test.get('rec') ->> 'issues')::int = 0 and jsonb_array_length(rls_test.get('rec') -> 'checks') = 13, rls_test.get('rec')::text);

-- ---------------------------------------------------------------------------
-- Cancellation, correction and reversal
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('reversal: a payment is reversed', 'rev', format('select public.customer_payment_reverse(%L, ''Cheque bounced - test'', %L)', rls_test.gid('pay2', 'payment_id'), gen_random_uuid()));
reset role;
select rls_test.ok('reversal: the reversed payment no longer counts (outstanding 9160 again, partially paid)',
  (rls_test.inv(rls_test.gid('inv', 'invoice_id')) ->> 'balance_due')::numeric = 9160 and rls_test.inv(rls_test.gid('inv', 'invoice_id')) ->> 'payment_status' = 'PARTIALLY_PAID'
  and (rls_test.party_bal(rls_test.gid('cus', 'party_id')) ->> 'receivable')::numeric = 9160);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('cancellation: order 2 cancelled', 'cx', format('select public.sales_order_v2_cancel(%L, ''Customer changed plan'', %L)', rls_test.gid('so2', 'sales_order_id'), gen_random_uuid()));
reset role;
select rls_test.ok('cancellation: its 8 basins and its materials are released',
  rls_test.reserved(rls_test.id('fg')) = 0 and rls_test.reserved(rls_test.id('clay')) = 0 and rls_test.reserved(rls_test.id('cpl')) = 0 and rls_test.on_hand(rls_test.id('fg')) = 8);
-- Correction: a second receipt of 10 KG, then reversed
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('correction: second PO for 10 KG', 'po2', format('select public.purchase_order_save(null, %L::jsonb, %L::jsonb, null, %L)',
  jsonb_build_object('supplier_id', rls_test.gid('sup', 'supplier_id'), 'purchase_type', 'RAW_MATERIAL', 'warehouse_id', rls_test.id('w1')),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('clay'), 'quantity', 10, 'unit_price', 20)), gen_random_uuid()));
select rls_test.call(format('select public.purchase_order_open(%L)', rls_test.gid('po2', 'po_id')));
select rls_test.expect_call_ok('correction: 10 KG received', 'grn2', format('select public.purchase_receipt_post(%L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('po2', 'po_id'),
  jsonb_build_object('receipt_date', rls_test.today()::text), jsonb_build_array(jsonb_build_object('po_line_id', rls_test.po_line(rls_test.gid('po2', 'po_id'), rls_test.id('clay')),
    'received_quantity', 10, 'accepted_quantity', 10, 'rejected_quantity', 0, 'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()));
reset role;
select rls_test.ok('correction: stock 60 KG and payable 4670 after the second receipt',
  rls_test.on_hand(rls_test.id('clay')) = 60 and (rls_test.party_bal(rls_test.gid('sup', 'party_id')) ->> 'payable')::numeric = 4670);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('correction: the receipt is reversed', 'grn2r', format('select public.purchase_receipt_reverse(%L, ''Entered against the wrong PO'', %L)',
  rls_test.gid('grn2', 'receipt_id'), gen_random_uuid()));
select rls_test.expect_call_error('duplicate: a receipt cannot be reversed twice', format('select public.purchase_receipt_reverse(%L, ''Again'', %L)',
  rls_test.gid('grn2', 'receipt_id'), gen_random_uuid()));
select rls_test.expect_call_ok('reconciliation after corrections', 'rec2', 'select public.erp_reconciliation()');
reset role;
select rls_test.ok('correction: the reversal restores 50 KG and payable 4460; reconciliation still clean',
  rls_test.on_hand(rls_test.id('clay')) = 50 and (rls_test.party_bal(rls_test.gid('sup', 'party_id')) ->> 'payable')::numeric = 4460
  and (rls_test.get('rec2') ->> 'issues')::int = 0, rls_test.get('rec2')::text);

-- ---------------------------------------------------------------------------
-- Settings, numbering, search, activity
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('settings: read', 'st0', 'select public.erp_settings_get()');
select rls_test.expect_call_ok('settings: company profile, date format, PO prefix, units, wastage', 'st1', format('select public.erp_settings_save(%L::jsonb, %L::jsonb)',
  jsonb_build_object('pan', 'aaace7777a', 'phone', '+91 20 1234 5678', 'email', 'Accounts@Alton.example', 'website', 'alton.example', 'fy_start_month', 4),
  jsonb_build_object('general.date_format', 'DD/MM/YYYY', 'numbering.po_prefix', 'APO', 'product.units', jsonb_build_array('PCS', 'KG', 'LTR'),
    'production.default_wastage_percent', 2.5)));
select rls_test.expect_call_error('settings: invalid prefix', format('select public.erp_settings_save(''{}''::jsonb, %L::jsonb)', '{"numbering.grn_prefix": "g1"}'), '2 to 5 capital');
select rls_test.expect_call_error('settings: prefixes must differ', format('select public.erp_settings_save(''{}''::jsonb, %L::jsonb)', '{"numbering.grn_prefix": "APO"}'), 'must all be different');
select rls_test.expect_call_error('settings: unknown key', format('select public.erp_settings_save(''{}''::jsonb, %L::jsonb)', '{"x.y": 1}'), 'Unknown setting');
select rls_test.expect_call_error('settings: invalid PAN', format('select public.erp_settings_save(%L::jsonb, ''{}''::jsonb)', '{"pan": "12345"}'), 'PAN');
select rls_test.expect_call_ok('settings: next PO uses the new prefix and continues the counter', 'po3', format('select public.purchase_order_save(null, %L::jsonb, %L::jsonb, null, %L)',
  jsonb_build_object('supplier_id', rls_test.gid('sup', 'supplier_id'), 'purchase_type', 'RAW_MATERIAL', 'warehouse_id', rls_test.id('w1')),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('clay'), 'quantity', 1, 'unit_price', 20)), gen_random_uuid()));
select rls_test.expect_call_ok('preferences readable by the operator', 'prefs', 'select public.erp_preferences()');
select rls_test.expect_call_ok('settings: automatic SKUs switched off', 'st2', format('select public.erp_settings_save(''{}''::jsonb, %L::jsonb)', '{"product.auto_sku": false}'));
select rls_test.expect_call_error('settings: a product without SKU is then refused', $q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status)
  values ('e7e5c800-0000-4000-8000-0000000000a1', null, 'No SKU', 'OTHER', 'OUTSOURCED', 'PCS', 'ACTIVE') returning '{}'::jsonb $q$, 'automatic SKU numbering is switched off');
reset role;
select rls_test.ok('settings: saved (PAN upper-cased, e-mail lower-cased, date format, units) and audited',
  rls_test.get('st1') -> 'company' ->> 'pan' = 'AAACE7777A' and rls_test.get('st1') -> 'company' ->> 'email' = 'accounts@alton.example'
  and rls_test.get('st1') -> 'settings' ->> 'general.date_format' = 'DD/MM/YYYY' and (rls_test.get('st1') -> 'settings' -> 'product.units') = '["PCS", "KG", "LTR"]'::jsonb
  and rls_test.get('prefs') ->> 'general.date_format' = 'DD/MM/YYYY'
  and exists (select 1 from public.audit_logs where company_id = rls_test.id('company_a') and action = 'settings.erp_updated'), rls_test.get('st1')::text);
select rls_test.ok('numbering: APO-000003 (the counter never restarts when the prefix changes)',
  (rls_test.po(rls_test.gid('po3', 'po_id'))).po_number = 'APO-000003', (rls_test.po(rls_test.gid('po3', 'po_id'))).po_number);

set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('search: partial product name, any case', 's1', 'select public.global_search(''wASH bas'')');
select rls_test.expect_call_ok('search: HSN code', 's2', 'select public.global_search(''6910'')');
select rls_test.expect_call_ok('search: customer', 's3', 'select public.global_search(''pune homes'')');
select rls_test.expect_call_ok('search: document numbers', 's4', 'select public.global_search(''000001'')');
select rls_test.expect_call_ok('search: one character returns nothing', 's5', 'select public.global_search(''a'')');
reset role;
select rls_test.ok('search: product by name and HSN, customer by name; links open the record',
  rls_test.get('s1') @> jsonb_build_array(jsonb_build_object('module', 'Product', 'reference', 'FG-000001', 'link', '/products/' || rls_test.id('fg')))
  and rls_test.get('s2') @> '[{"module": "Product", "reference": "FG-000001"}]'::jsonb
  and rls_test.get('s3') @> jsonb_build_array(jsonb_build_object('module', 'Customer', 'link', '/ledger/' || rls_test.gid('cus', 'party_id')))
  and jsonb_array_length(rls_test.get('s5')) = 0, rls_test.get('s1')::text);
select rls_test.ok('search: PO, GRN, production order, sales order and SKUs found by number',
  (select count(distinct r ->> 'module') from jsonb_array_elements(rls_test.get('s4')) r
   where r ->> 'module' in ('Purchase order', 'Goods receipt', 'Production order', 'Sales order', 'Product')) = 5, rls_test.get('s4')::text);

set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('activity centre', 'act', format('select public.activity_feed(%L, %L)', rls_test.today() - 1, rls_test.today()));
select rls_test.expect_call_ok('activity centre: filtered to payments', 'act2', format('select public.activity_feed(%L, %L, ''PAYMENT_RECEIVED'')', rls_test.today() - 1, rls_test.today()));
reset role;
select rls_test.ok('activity: every step of the flow is listed with its reference and link',
  (select bool_and(rls_test.get('act') -> 'by_type' ? t) from unnest(array['PRODUCT_CREATED', 'BOM_UPDATED', 'SUPPLIER_ADDED', 'CUSTOMER_ADDED', 'PURCHASE_ORDER_CREATED',
     'GOODS_RECEIVED', 'GOODS_RECEIPT_REVERSED', 'PRODUCTION_STARTED', 'PRODUCTION_COMPLETED', 'SALES_ORDER_CREATED', 'STOCK_RESERVED', 'STOCK_DISPATCHED',
     'INVOICE_CREATED', 'PAYMENT_RECEIVED', 'PAYMENT_REVERSED']) t)
  and not exists (select 1 from jsonb_array_elements(rls_test.get('act') -> 'rows') r where coalesce(r ->> 'link', '') = '' or coalesce(r ->> 'reference', '') = ''),
  (rls_test.get('act') -> 'by_type')::text);
select rls_test.ok('activity: type filter (one recorded payment remains, the other is reversed)',
  (rls_test.get('act2') ->> 'total')::int = 1, rls_test.get('act2')::text);

-- ---------------------------------------------------------------------------
-- Empty company and isolation
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('b_op');
select rls_test.expect_call_ok('empty company: overview', 'ovb', format('select public.management_overview(%L, %L)', rls_test.today() - 30, rls_test.today()));
select rls_test.expect_call_ok('empty company: search', 'sb', 'select public.global_search(''wash'')');
select rls_test.expect_call_ok('empty company: reconciliation', 'recb', 'select public.erp_reconciliation()');
select rls_test.expect_call_ok('empty company: invoice register', 'rb', rls_test.report('INVOICE_REGISTER'));
select rls_test.expect_call_ok('empty company: activity', 'actb', format('select public.activity_feed(%L, %L)', rls_test.today() - 30, rls_test.today()));
reset role;
select rls_test.ok('empty company: zeros, empty lists, no errors, and nothing from company A',
  (rls_test.get('ovb') -> 'kpis' ->> 'sales_invoiced')::numeric = 0 and (rls_test.get('ovb') -> 'kpis' ->> 'inventory_value') is null
  and jsonb_array_length(rls_test.get('ovb') -> 'inventory' -> 'physical') = 0 and jsonb_array_length(rls_test.get('sb')) = 0
  and (rls_test.get('recb') ->> 'issues')::int = 0 and (rls_test.get('rb') ->> 'count')::int = 0 and (rls_test.get('actb') ->> 'total')::int = 0,
  rls_test.get('ovb')::text);
select rls_test.ok('grants: anon cannot call the Stage 7 functions',
  not has_function_privilege('anon', 'public.management_overview(date, date)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.erp_report(text, jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.global_search(text, integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.erp_settings_save(jsonb, jsonb)', 'EXECUTE'));

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
  raise exception 'STAGE7_E2E_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
