-- =============================================================================
-- STOCK REGISTER, STOCK MOVEMENT ACCURACY AND DUPLICATE-SAFE PRODUCTION
-- (ALTON ERP V2) — migration 20261111090000_stock_register_reliability.sql
--
--  1 invoice draft does not move stock          9 pending PO after a partial receipt
--  2 the posting event deducts stock once       10 PO amendment recalculates pending
--  3 a repeated posting does not deduct twice   11 repeated production request -> same order
--  4 dispatch converts the reservation          12 a new request id -> a separate order
--  5 accepted GRN quantity adds stock           13 one request id can never create two orders
--  6 rejected GRN quantity adds no stock        14 company isolation
--  7 reversals restore the quantity             15 ledger and balances reconcile
--  8 BOM shortage includes wastage
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
-- Runs in one transaction and ALWAYS ends by raising
--   STOCK_RELIABILITY_VERIFICATION_RESULT passed=N failed=M
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
create function rls_test.grn(p_product uuid, p_qty numeric) returns text language sql stable as $$
  select format('select public.goods_receipt_direct_post(%L::jsonb, %L::jsonb, %L)', jsonb_build_object('warehouse_id', rls_test.id('w1')),
    jsonb_build_array(jsonb_build_object('product_id', p_product, 'received_quantity', p_qty, 'accepted_quantity', p_qty, 'unit_cost', 10,
      'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()) $$;
-- Owner-side probes (bypass RLS).
create function rls_test.on_hand(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(on_hand), 0) from public.inventory_balances where product_id = p_product $$;
create function rls_test.reserved(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(reserved), 0) from public.inventory_balances where product_id = p_product $$;
create function rls_test.tx_count(p_company uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.inventory_transactions where company_id = p_company $$;
create function rls_test.orders(p_company uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.production_orders where company_id = p_company $$;
create function rls_test.prod_res(p_order uuid, p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(quantity - fulfilled_quantity - released_quantity), 0) from public.stock_reservations
  where reference_type = 'PRODUCTION_ORDER' and reference_id = p_order and product_id = p_product and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') $$;
create function rls_test.sol(p_so uuid) returns uuid language sql stable security definer as $$
  select id from public.sales_order_lines where sales_order_id = p_so order by line_no limit 1 $$;
create function rls_test.po_line(p_po uuid) returns uuid language sql stable security definer as $$
  select id from public.purchase_order_lines where purchase_order_id = p_po order by line_no limit 1 $$;
create function rls_test.fulfilment(p_so uuid) returns uuid language sql stable security definer as $$
  select id from public.fulfilments where sales_order_id = p_so order by created_at limit 1 $$;
create function rls_test.pos(p_rows jsonb, p_sku text) returns jsonb language sql immutable as $$
  select r from jsonb_array_elements(p_rows -> 'rows') r where r ->> 'sku' = p_sku $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5cc00-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5cc00-0000-4000-8000-0000000000b1'),
  ('op', 'e7e5cc00-0000-4000-8000-000000000001'), ('b_op', 'e7e5cc00-0000-4000-8000-000000000002'),
  ('cx', 'e7e5cc00-0000-4000-8000-0000000000c1'), ('s1', 'e7e5cc00-0000-4000-8000-0000000000c2'),
  ('fg', 'e7e5cc00-0000-4000-8000-0000000000d1'), ('ca', 'e7e5cc00-0000-4000-8000-0000000000d2'), ('rm', 'e7e5cc00-0000-4000-8000-0000000000d3'),
  ('w1', 'e7e5cc00-0000-4000-8000-0000000000e1'), ('w2', 'e7e5cc00-0000-4000-8000-0000000000e2'), ('wb', 'e7e5cc00-0000-4000-8000-0000000000e3'),
  ('p1', 'e7e5cc00-0000-4000-8000-0000000000f1'), ('p2', 'e7e5cc00-0000-4000-8000-0000000000f2'), ('k_dispatch', 'e7e5cc00-0000-4000-8000-0000000000f3');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code, gstin, legal_address) values
  (rls_test.id('company_a'), 'Stock Reliability A Pvt Ltd', 'SR A', 'SRA', '27AAACS1234A1Z5', 'Pune'),
  (rls_test.id('company_b'), 'Stock Reliability B', 'SR B', 'SRB', null, null);
insert into auth.users (id, email) select id, key || '@sr.example.invalid' from rls_test.ids where key in ('op', 'b_op');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = rls_test.id('op');
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_op');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('op'), rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('b_op'), rls_test.id('company_b'), rls_test.id('role_super_admin'));
insert into public.customers (id, company_id, customer_code, customer_name, status, gstin, gst_registration_type, billing_state_code, billing_address) values
  (rls_test.id('cx'), rls_test.id('company_a'), 'SR-CX', 'Xylo Homes', 'ACTIVE', '27AABCX1234A1Z5', 'REGISTERED', '27', 'Pune');
insert into public.suppliers (id, company_id, supplier_code, legal_name, gstin, state_code, payment_terms, status) values
  (rls_test.id('s1'), rls_test.id('company_a'), 'SR-S1', 'Pune Brass Works', '27AAPFU0939F1ZV', '27', 'DAYS_30', 'ACTIVE');
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, status, selling_price, gst_rate, hsn_code, standard_cost) values
  (rls_test.id('fg'), rls_test.id('company_a'), 'SR-FG', 'Basin mixer', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', 1000, 18, '84818020', null),
  (rls_test.id('ca'), rls_test.id('company_a'), 'SR-CA', 'Brass body', 'COMPONENT', 'OUTSOURCED', 'PCS', 'ACTIVE', null, 18, '7412', 100),
  (rls_test.id('rm'), rls_test.id('company_a'), 'SR-RM', 'Chrome plating salt', 'RAW_MATERIAL', 'OUTSOURCED', 'KG', 'ACTIVE', null, 18, '2833', 50);
insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Factory', true), (rls_test.id('w2'), rls_test.id('company_a'), 'W2', 'Depot', false),
  (rls_test.id('wb'), rls_test.id('company_b'), 'W1', 'B factory', true);
insert into rls_test.ids (key, id)
select case warehouse_id when rls_test.id('w1') then 'g1' when rls_test.id('w2') then 'g2' else 'gb' end, id
from public.inventory_locations where location_code = 'GENERAL' and warehouse_id in (rls_test.id('w1'), rls_test.id('w2'), rls_test.id('wb'));

set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('setup: 30 basin mixers in stock', 'g_fg', rls_test.grn(rls_test.id('fg'), 30));
select rls_test.expect_call_ok('setup: 50 brass bodies in stock', 'g_ca', rls_test.grn(rls_test.id('ca'), 50));
select rls_test.expect_call_ok('setup: BOM of SR-FG: 2 brass bodies (+5% wastage), 0.5 KG plating salt (+10%)', 'bom',
  format('select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, %L)', rls_test.id('fg'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('ca'), 'quantity_required', 2, 'wastage_percentage', 5),
      jsonb_build_object('component_product_id', rls_test.id('rm'), 'quantity_required', 0.5, 'wastage_percentage', 10)), gen_random_uuid()));
select rls_test.expect_call_ok('setup: activate the BOM', 'bom_act', format('select public.production_bom_activate(%L, null)', rls_test.gid('bom', 'bom_id')));
select rls_test.expect_call_ok('reconciliation before the tests', 'rec0', 'select public.inventory_reconciliation()');
reset role;
select rls_test.set('tx0', to_jsonb(rls_test.tx_count(rls_test.id('company_a'))));
select rls_test.ok('reconciliation (before): ledger and balances agree, no issues', (rls_test.get('rec0') ->> 'issues')::int = 0, rls_test.get('rec0')::text);

-- ---------------------------------------------------------------------------
-- 1-3. Invoices never move stock; the dispatch posts once
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('invoice: draft for 5 basin mixers', 'inv',
  format('select public.sales_invoice_v2_save(null, %L::jsonb, %L::jsonb, null, %L)', jsonb_build_object('customer_id', rls_test.id('cx')),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('fg'), 'quantity', 5)), gen_random_uuid()));
reset role;
select rls_test.ok('1. invoice draft: stock unchanged (30) and no stock movement', rls_test.on_hand(rls_test.id('fg')) = 30
  and rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx0'))::bigint);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('invoice: posting the undispatched manual invoice is refused (20261112 dispatch-before-invoice rule)',
  format('select public.sales_invoice_v2_issue(%L, false, %L)', rls_test.gid('inv', 'invoice_id'), gen_random_uuid()), 'Dispatch the goods before posting');
reset role;
select rls_test.ok('2. invoice posting attempt: stock still 30 — the dispatch is the single stock-out event, the invoice is not',
  rls_test.on_hand(rls_test.id('fg')) = 30 and rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx0'))::bigint);

set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('sales order: 10 basin mixers (reserved from stock)', 'so',
  format('select public.sales_order_v2_save(null, %L::jsonb, %L::jsonb, %L)', jsonb_build_object('customer_id', rls_test.id('cx')),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('fg'), 'quantity', 10)), gen_random_uuid()));
reset role;
select rls_test.ok('sales order: 10 reserved, 30 on hand, 20 available', rls_test.reserved(rls_test.id('fg')) = 10 and rls_test.on_hand(rls_test.id('fg')) = 30);
select rls_test.set('tx1', to_jsonb(rls_test.tx_count(rls_test.id('company_a'))));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('dispatch 4', 'd1', format('select public.sales_order_v2_dispatch(%L, %L::jsonb, ''{}''::jsonb, %L)', rls_test.gid('so', 'sales_order_id'),
  jsonb_build_array(jsonb_build_object('line_id', rls_test.sol(rls_test.gid('so', 'sales_order_id')), 'quantity', 4)), rls_test.id('k_dispatch')));
reset role;
select rls_test.ok('2. dispatch: 4 deducted once (30 -> 26) with one ISSUE movement',
  rls_test.on_hand(rls_test.id('fg')) = 26 and rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx1'))::bigint + 1);
select rls_test.ok('4. dispatch: the reservation is converted (reserved 10 -> 6), not left behind', rls_test.reserved(rls_test.id('fg')) = 6);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('3. the same dispatch request again (retry after a timeout)', 'd1b',
  format('select public.sales_order_v2_dispatch(%L, %L::jsonb, ''{}''::jsonb, %L)', rls_test.gid('so', 'sales_order_id'),
    jsonb_build_array(jsonb_build_object('line_id', rls_test.sol(rls_test.gid('so', 'sales_order_id')), 'quantity', 4)), rls_test.id('k_dispatch')));
reset role;
select rls_test.ok('3. repeated dispatch request: the first result is returned (duplicate) and nothing is deducted again',
  (rls_test.get('d1b') ->> 'duplicate')::boolean and rls_test.on_hand(rls_test.id('fg')) = 26 and rls_test.reserved(rls_test.id('fg')) = 6
  and rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx1'))::bigint + 1, rls_test.get('d1b')::text);
select rls_test.ok('3. the repeated request is in the audit log',
  exists (select 1 from public.audit_logs where company_id = rls_test.id('company_a') and action = 'request.duplicate_returned'
          and metadata ->> 'operation' = 'sales_order_v2_dispatch'));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('7. reverse the dispatch', 'drev', format('select public.sales_order_v2_reverse_dispatch(%L, %L, %L)',
  rls_test.fulfilment(rls_test.gid('so', 'sales_order_id')), 'Truck returned to the factory', gen_random_uuid()));
reset role;
select rls_test.ok('7. dispatch reversal: compensating movement restores 30 on hand and the 10 reserved; the ISSUE stays in the ledger',
  rls_test.on_hand(rls_test.id('fg')) = 30 and rls_test.reserved(rls_test.id('fg')) = 10
  and exists (select 1 from public.inventory_transactions where product_id = rls_test.id('fg') and transaction_type = 'ISSUE')
  and exists (select 1 from public.inventory_transactions where product_id = rls_test.id('fg') and transaction_type = 'REVERSAL'));

-- ---------------------------------------------------------------------------
-- 5, 6, 9, 10. Purchase orders and goods receipts
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('PO: 40 brass bodies', 'po', format('select public.purchase_order_save(null, %L::jsonb, %L::jsonb, null, %L)',
  jsonb_build_object('supplier_id', rls_test.id('s1'), 'purchase_type', 'RAW_MATERIAL', 'warehouse_id', rls_test.id('w1'), 'payment_terms', 'DAYS_30'),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('ca'), 'quantity', 40, 'unit_price', 100)), gen_random_uuid()));
select rls_test.call(format('select public.purchase_order_open(%L)', rls_test.gid('po', 'po_id')));
select rls_test.expect_call_ok('stock position with the open PO', 'sp0', 'select public.inventory_stock_position(''{}''::jsonb)');
reset role;
select rls_test.ok('pending PO 40; it is not on-hand stock (on hand stays 50)',
  (rls_test.pos(rls_test.get('sp0'), 'SR-CA') ->> 'pending_po_quantity')::numeric = 40 and (rls_test.pos(rls_test.get('sp0'), 'SR-CA') ->> 'on_hand')::numeric = 50
  and (rls_test.pos(rls_test.get('sp0'), 'SR-CA') ->> 'expected_incoming_quantity')::numeric = 40, (rls_test.pos(rls_test.get('sp0'), 'SR-CA'))::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('GRN: 15 received, 10 accepted, 5 rejected (recorded, not stocked)', 'grn',
  format('select public.purchase_receipt_post(%L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('po', 'po_id'), '{}',
    jsonb_build_array(jsonb_build_object('po_line_id', rls_test.po_line(rls_test.gid('po', 'po_id')), 'received_quantity', 15, 'accepted_quantity', 10,
      'rejected_quantity', 5, 'accepted_location_id', rls_test.id('g1'), 'rejection_reason', 'Porous casting')), gen_random_uuid()));
select rls_test.expect_call_ok('stock position after the GRN', 'sp1', 'select public.inventory_stock_position(''{}''::jsonb)');
reset role;
select rls_test.ok('5. accepted GRN quantity adds stock (50 + 10 = 60)', rls_test.on_hand(rls_test.id('ca')) = 60);
select rls_test.ok('6. the 5 rejected add no stock and no available stock', (rls_test.pos(rls_test.get('sp1'), 'SR-CA') ->> 'available')::numeric = 60);
select rls_test.ok('9. pending PO after a partial receipt = 40 ordered − 10 accepted = 30 (rejected goods are still owed)',
  (rls_test.pos(rls_test.get('sp1'), 'SR-CA') ->> 'pending_po_quantity')::numeric = 30, (rls_test.pos(rls_test.get('sp1'), 'SR-CA'))::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('10. amend the PO (supplier cut the order to 25)', 'amend', format('select public.purchase_order_action(%L, %L, %L)', rls_test.gid('po', 'po_id'), 'AMEND', 'Supplier can only supply 25'));
select rls_test.expect_call_ok('10. save the amended quantity', 'amend_save', format('select public.purchase_order_save(%L, %L::jsonb, %L::jsonb, null, null)', rls_test.gid('po', 'po_id'),
  jsonb_build_object('supplier_id', rls_test.id('s1'), 'purchase_type', 'RAW_MATERIAL', 'warehouse_id', rls_test.id('w1'), 'payment_terms', 'DAYS_30'),
  jsonb_build_array(jsonb_build_object('id', rls_test.po_line(rls_test.gid('po', 'po_id')), 'product_id', rls_test.id('ca'), 'quantity', 25, 'unit_price', 100))));
select rls_test.expect_call_ok('10. reopen the amended order', 'reopen', format('select public.purchase_order_open(%L)', rls_test.gid('po', 'po_id')));
select rls_test.expect_call_ok('stock position after the amendment', 'sp2', 'select public.inventory_stock_position(''{"pending_po_only": true}''::jsonb)');
reset role;
select rls_test.ok('10. pending PO recalculated after the amendment: 25 − 10 accepted = 15; the pending-PO filter lists it',
  (rls_test.pos(rls_test.get('sp2'), 'SR-CA') ->> 'pending_po_quantity')::numeric = 15 and rls_test.pos(rls_test.get('sp2'), 'SR-FG') is null,
  rls_test.get('sp2')::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('7. reverse the GRN', 'grn_rev', format('select public.goods_receipt_reverse(%L, %L, %L)', rls_test.gid('grn', 'receipt_id'), 'Wrong supplier delivery', gen_random_uuid()));
select rls_test.expect_call_ok('stock position after the GRN reversal', 'sp3', 'select public.inventory_stock_position(''{}''::jsonb)');
reset role;
select rls_test.ok('7. GRN reversal takes the 10 back out (60 -> 50) and pending PO returns to 25',
  rls_test.on_hand(rls_test.id('ca')) = 50 and (rls_test.pos(rls_test.get('sp3'), 'SR-CA') ->> 'pending_po_quantity')::numeric = 25);

-- ---------------------------------------------------------------------------
-- 8, 11-13. Production: BOM requirement with wastage, duplicate-safe creation
-- Order for 10 SR-FG: brass bodies 2 x 10 x 1.05 = 21 (50 in stock -> reserved),
-- plating salt 0.5 x 10 x 1.10 = 5.5 KG (none in stock -> shortage 5.5).
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('production: order for 10 (request id P1)', 'o1', format('select public.production_order_v2_save(null, %L::jsonb, %L)',
  jsonb_build_object('product_id', rls_test.id('fg'), 'planned_quantity', 10, 'production_date', rls_test.today(), 'warehouse_id', rls_test.id('w1')), rls_test.id('p1')));
select rls_test.expect_call_ok('stock position with the production order', 'sp4', 'select public.inventory_stock_position(''{}''::jsonb)');
select rls_test.expect_call_ok('shortage filter', 'sp4s', 'select public.inventory_stock_position(''{"shortage_only": true}''::jsonb)');
reset role;
select rls_test.set('orders1', to_jsonb(rls_test.orders(rls_test.id('company_a'))));
select rls_test.ok('8. BOM requirement includes wastage: 21 brass bodies reserved for the order (2 x 10 + 5%)',
  rls_test.prod_res(rls_test.gid('o1', 'order_id'), rls_test.id('ca')) = 21);
select rls_test.ok('8. plating salt: 5.5 KG required (0.5 x 10 + 10%), none available -> BOM shortage 5.5; brass bodies fully reserved -> no shortage',
  (rls_test.pos(rls_test.get('sp4'), 'SR-RM') ->> 'bom_required_quantity')::numeric = 5.5 and (rls_test.pos(rls_test.get('sp4'), 'SR-RM') ->> 'bom_shortage_quantity')::numeric = 5.5
  and (rls_test.pos(rls_test.get('sp4'), 'SR-CA') ->> 'bom_required_quantity')::numeric = 0 and (rls_test.pos(rls_test.get('sp4'), 'SR-CA') ->> 'bom_shortage_quantity')::numeric = 0
  and (rls_test.pos(rls_test.get('sp4'), 'SR-CA') ->> 'reserved')::numeric = 21,
  jsonb_build_array(rls_test.pos(rls_test.get('sp4'), 'SR-RM'), rls_test.pos(rls_test.get('sp4'), 'SR-CA'))::text);
select rls_test.ok('8. output of the open order is expected incoming for SR-FG (10); the shortage filter lists only SR-RM',
  (rls_test.pos(rls_test.get('sp4'), 'SR-FG') ->> 'pending_production_quantity')::numeric = 10
  and (rls_test.pos(rls_test.get('sp4'), 'SR-FG') ->> 'expected_incoming_quantity')::numeric = 10
  and jsonb_array_length(rls_test.get('sp4s') -> 'rows') = 1 and rls_test.pos(rls_test.get('sp4s'), 'SR-RM') is not null);
select rls_test.ok('13. the order carries its creation request id', (select request_id from public.production_order_requests where production_order_id = rls_test.gid('o1', 'order_id')) = rls_test.id('p1'));

set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('11. the same request again (retry after a timeout)', 'o1b', format('select public.production_order_v2_save(null, %L::jsonb, %L)',
  jsonb_build_object('product_id', rls_test.id('fg'), 'planned_quantity', 10, 'production_date', rls_test.today(), 'warehouse_id', rls_test.id('w1')), rls_test.id('p1')));
reset role;
select rls_test.ok('11. repeated request returns the existing order; no new order and no extra reservation',
  rls_test.gid('o1b', 'order_id') = rls_test.gid('o1', 'order_id') and (rls_test.get('o1b') ->> 'duplicate')::boolean
  and rls_test.orders(rls_test.id('company_a')) = (rls_test.get('orders1'))::bigint
  and rls_test.prod_res(rls_test.gid('o1', 'order_id'), rls_test.id('ca')) = 21 and rls_test.reserved(rls_test.id('ca')) = 21, rls_test.get('o1b')::text);
select rls_test.ok('11. the duplicate attempt is logged',
  exists (select 1 from public.audit_logs where action = 'request.duplicate_returned' and resource_id = rls_test.id('p1')::text
          and metadata ->> 'operation' = 'production_v2_save' and metadata ->> 'record' = rls_test.get('o1') ->> 'production_order_number'));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('12. a second batch for the same product with a new request id (P2)', 'o2', format('select public.production_order_v2_save(null, %L::jsonb, %L)',
  jsonb_build_object('product_id', rls_test.id('fg'), 'planned_quantity', 5, 'production_date', rls_test.today(), 'warehouse_id', rls_test.id('w1')), rls_test.id('p2')));
select rls_test.expect_call_error('13. a request id cannot be reused for another operation', format('select public.sales_order_v2_dispatch(%L, %L::jsonb, ''{}''::jsonb, %L)',
  rls_test.gid('so', 'sales_order_id'), jsonb_build_array(jsonb_build_object('line_id', rls_test.sol(rls_test.gid('so', 'sales_order_id')), 'quantity', 1)), rls_test.id('p1')),
  'different operation');
reset role;
select rls_test.ok('12. separate request ids create separate valid orders for the same product and BOM',
  rls_test.gid('o2', 'order_id') <> rls_test.gid('o1', 'order_id') and rls_test.orders(rls_test.id('company_a')) = (rls_test.get('orders1'))::bigint + 1
  and (select request_id from public.production_order_requests where production_order_id = rls_test.gid('o2', 'order_id')) = rls_test.id('p2'));
-- A concurrent second call with the same id waits on the unique request row and
-- then returns the first result (PGlite has one connection, so the database
-- guarantees are checked directly): the request table and the order itself.
select rls_test.ok('13. the request table allows each request id once per company (unique index)',
  exists (select 1 from pg_indexes where tablename = 'inventory_requests' and indexdef ilike '%unique%company_id%idempotency_key%')
  or exists (select 1 from pg_constraint where conrelid = 'public.inventory_requests'::regclass and contype in ('u', 'p')
             and pg_get_constraintdef(oid) ilike '%company_id%idempotency_key%'));
select rls_test.ok('13. one request id can never be recorded for a second production order (unique per company)',
  (rls_test.call(format('insert into public.production_order_requests (production_order_id, company_id, request_id, operation) values (%L, %L, %L, %L) returning jsonb_build_object(''id'', production_order_id)',
     rls_test.gid('o2', 'order_id'), rls_test.id('company_a'), rls_test.id('p1'), 'production_v2_save')) ->> 'sqlstate') in ('23505'));

-- ---------------------------------------------------------------------------
-- Stock register detail, warehouse filter
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('detail of the brass body', 'det', format('select public.inventory_stock_position_detail(%L, null)', rls_test.id('ca')));
select rls_test.expect_call_ok('detail of the finished product', 'det_fg', format('select public.inventory_stock_position_detail(%L, null)', rls_test.id('fg')));
select rls_test.expect_call_ok('warehouse filter: W2 (empty depot)', 'sp_w2', format('select public.inventory_stock_position(%L::jsonb)', jsonb_build_object('warehouse_id', rls_test.id('w2'))));
reset role;
select rls_test.ok('detail: lots by warehouse / location, the open PO with 25 pending, the reversed GRN, and the production order using it',
  jsonb_array_length(rls_test.get('det') -> 'locations') >= 1 and (rls_test.get('det') -> 'purchase_orders' -> 0 ->> 'pending')::numeric = 25
  and rls_test.get('det') -> 'goods_receipts' -> 0 ->> 'status' = 'REVERSED'
  and exists (select 1 from jsonb_array_elements(rls_test.get('det') -> 'production_orders') x where x ->> 'role' = 'MATERIAL' and (x ->> 'reserved')::numeric = 21),
  rls_test.get('det')::text);
select rls_test.ok('detail: BOM components of the finished product (2 lines with wastage) and its open production orders',
  jsonb_array_length(rls_test.get('det_fg') -> 'bom_components') = 2 and jsonb_array_length(rls_test.get('det_fg') -> 'production_orders') = 2);
select rls_test.ok('warehouse filter: nothing on hand or pending in W2',
  (rls_test.pos(rls_test.get('sp_w2'), 'SR-CA') ->> 'on_hand')::numeric = 0 and (rls_test.pos(rls_test.get('sp_w2'), 'SR-CA') ->> 'pending_po_quantity')::numeric = 0);

-- ---------------------------------------------------------------------------
-- 14. Company isolation
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('b_op');
select rls_test.expect_call_ok('company B stock register', 'b_sp', 'select public.inventory_stock_position(''{}''::jsonb)');
select rls_test.expect_call_ok('company B reconciliation', 'b_rec', 'select public.inventory_reconciliation()');
select rls_test.expect_call_error('14. company B cannot open company A''s product detail', format('select public.inventory_stock_position_detail(%L, null)', rls_test.id('ca')), 'not found');
select rls_test.expect_call_error('14. company B cannot filter by company A''s warehouse', format('select public.inventory_stock_position(%L::jsonb)', jsonb_build_object('warehouse_id', rls_test.id('w1'))), 'not found');
select rls_test.expect_call_error('14. company B cannot dispatch company A''s sales order', format('select public.sales_order_v2_dispatch(%L, %L::jsonb, ''{}''::jsonb, %L)',
  rls_test.gid('so', 'sales_order_id'), jsonb_build_array(jsonb_build_object('line_id', rls_test.sol(rls_test.gid('so', 'sales_order_id')), 'quantity', 1)), gen_random_uuid()), 'not found');
select rls_test.ok('14. company B sees none of company A''s stock, balances or ledger rows',
  rls_test.pos(rls_test.get('b_sp'), 'SR-CA') is null and (rls_test.get('b_rec') ->> 'checked_lots')::int = 0
  and not exists (select 1 from public.inventory_balances) and not exists (select 1 from public.inventory_transactions));
reset role;
select rls_test.ok('grants: anon cannot call the new functions; clients cannot write balances or the ledger',
  not has_function_privilege('anon', 'public.inventory_stock_position(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.inventory_stock_position_detail(uuid, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.inventory_reconciliation(uuid)', 'EXECUTE')
  and not has_table_privilege('authenticated', 'public.inventory_balances', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.inventory_transactions', 'INSERT'));

-- ---------------------------------------------------------------------------
-- 15. Ledger and balances reconcile; a discrepancy is detected
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('reconciliation after all postings', 'rec1', 'select public.inventory_reconciliation()');
select rls_test.expect_call_ok('stock position after all postings', 'sp5', 'select public.inventory_stock_position(''{}''::jsonb)');
reset role;
select rls_test.ok('15. after every posting and reversal: no discrepancy (balances = ledger, reserved = reservations, nothing negative)',
  (rls_test.get('rec1') ->> 'issues')::int = 0 and (rls_test.get('rec1') ->> 'checked_lots')::int > 0
  and not exists (select 1 from jsonb_array_elements(rls_test.get('sp5') -> 'rows') r where (r ->> 'discrepancy')::boolean), rls_test.get('rec1')::text);
select rls_test.claims('op');
do $$
declare r jsonb;
begin
  begin
    -- Simulated corruption of a balance (never done by the application), rolled back below.
    update public.inventory_balances set on_hand = on_hand + 1 where product_id = rls_test.id('fg');
    r := public.inventory_reconciliation(rls_test.id('fg')) || jsonb_build_object('position', public.inventory_stock_position(jsonb_build_object('product_id', rls_test.id('fg'))));
    raise exception using errcode = 'P0099', message = r::text;
  exception
    when sqlstate 'P0099' then r := sqlerrm::jsonb;
    when others then r := jsonb_build_object('blocked', sqlerrm);
  end;
  perform rls_test.ok('15. a balance that differs from the ledger is reported (or the direct change is refused)',
    r ? 'blocked' or ((r ->> 'issues')::int >= 1 and r -> 'rows' -> 0 -> 'problems' ? 'BALANCE_DIFFERS_FROM_LEDGER'
      and (r -> 'rows' -> 0 ->> 'difference')::numeric = 1 and (r -> 'position' -> 'rows' -> 0 ->> 'discrepancy')::boolean), r::text);
end;
$$;
select rls_test.ok('15. the simulated change was rolled back (fg on hand 30 again)', rls_test.on_hand(rls_test.id('fg')) = 30);

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
  raise exception 'STOCK_RELIABILITY_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
