-- =============================================================================
-- PURCHASE ORDERS & GOODS RECEIPTS VERIFICATION (ALTON ERP V2, Stage 3)
--
-- Checks the PO and GRN calculations end to end and migration
-- 20261104090000_purchasing_grn_v2.sql: PO amounts (discounts, intra-state,
-- inter-state and unregistered GST, charges), opening without approval, partial
-- and multiple receipts, ordered / received / accepted / pending quantities and
-- statuses, stock only from accepted goods, rejected goods never available,
-- over-receipts, reversal, atomic correction, direct (unlinked) receipts,
-- delivery-date changes, supplier payables, attachments, the stock ledger and
-- company isolation.
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction and ALWAYS ends by raising
--   PURCHASING_V2_VERIFICATION_RESULT passed=N failed=M
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
create function rls_test.save_po(p_header jsonb, p_lines jsonb) returns text language sql stable as $$
  select format('select public.purchase_order_save(null, %L::jsonb, %L::jsonb, null, %L)', p_header, p_lines, gen_random_uuid()) $$;
-- Receipt line json for a PO line.
create function rls_test.rl(p_line uuid, p_recv numeric, p_acc numeric, p_rej numeric default 0, p_loc uuid default null, p_reason text default null,
  p_rej_loc uuid default null, p_over text default null) returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object('po_line_id', p_line, 'received_quantity', p_recv, 'accepted_quantity', p_acc, 'rejected_quantity', p_rej,
    'accepted_location_id', p_loc, 'rejection_reason', p_reason, 'rejected_location_id', p_rej_loc, 'over_receipt_reason', p_over)) $$;

-- Owner-side probes (bypass RLS).
create function rls_test.po(p_id uuid) returns public.purchase_orders language sql stable security definer as $$ select * from public.purchase_orders where id = p_id $$;
create function rls_test.line(p_po uuid, p_no int) returns public.purchase_order_lines language sql stable security definer as $$
  select * from public.purchase_order_lines where purchase_order_id = p_po and line_no = p_no $$;
create function rls_test.qty(p_po uuid, p_no int) returns jsonb language sql stable security definer as $$
  select jsonb_build_object('ordered', ordered_quantity, 'received', received_quantity, 'accepted', accepted_quantity, 'rejected', rejected_quantity, 'pending', pending_quantity)
  from public.purchase_order_line_list where purchase_order_id = p_po and line_no = p_no $$;
create function rls_test.grn(p_id uuid) returns public.goods_receipts language sql stable security definer as $$ select * from public.goods_receipts where id = p_id $$;
create function rls_test.on_hand(p_product uuid, p_location uuid default null) returns numeric language sql stable security definer as $$
  select coalesce(sum(on_hand), 0) from public.inventory_balances where product_id = p_product and (p_location is null or location_id = p_location) $$;
create function rls_test.available(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(b.on_hand - b.reserved), 0) from public.inventory_balances b join public.inventory_locations l on l.id = b.location_id
  where b.product_id = p_product and l.stock_usage = 'STORAGE' $$;
create function rls_test.tx_count(p_company uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.inventory_transactions where company_id = p_company $$;
-- Ledger invariant: every balance equals the signed sum of its transactions.
create function rls_test.ledger_consistent(p_company uuid) returns boolean language sql stable security definer as $$
  select not exists (
    select 1 from public.inventory_balances b
    where b.company_id = p_company
      and b.on_hand <> coalesce((select sum(t.direction * t.quantity) from public.inventory_transactions t where t.batch_id = b.batch_id and t.location_id = b.location_id), 0)) $$;
create function rls_test.events(p_po uuid) returns text[] language sql stable security definer as $$
  select array_agg(event_type order by created_at, id) from public.purchase_order_events where purchase_order_id = p_po $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5c400-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5c400-0000-4000-8000-0000000000b1'),
  ('op', 'e7e5c400-0000-4000-8000-000000000001'), ('b_op', 'e7e5c400-0000-4000-8000-000000000002'),
  ('s_intra', 'e7e5c400-0000-4000-8000-0000000000c1'), ('s_inter', 'e7e5c400-0000-4000-8000-0000000000c2'), ('s_unreg', 'e7e5c400-0000-4000-8000-0000000000c3'),
  ('basin', 'e7e5c400-0000-4000-8000-0000000000d1'), ('clay', 'e7e5c400-0000-4000-8000-0000000000d2'), ('valve', 'e7e5c400-0000-4000-8000-0000000000d3'),
  ('w1', 'e7e5c400-0000-4000-8000-0000000000e1'), ('w2', 'e7e5c400-0000-4000-8000-0000000000e2'), ('wb', 'e7e5c400-0000-4000-8000-0000000000e3'),
  ('rej', 'e7e5c400-0000-4000-8000-0000000000f1');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code, gstin, legal_address) values
  (rls_test.id('company_a'), 'Purchasing V2 A Pvt Ltd', 'Purchasing A', 'PGA', '27AAACP1234A1Z5', 'Pune'),
  (rls_test.id('company_b'), 'Purchasing V2 B', 'Purchasing B', 'PGB', null, null);
insert into auth.users (id, email) select id, key || '@pg.example.invalid' from rls_test.ids where key in ('op', 'b_op');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = rls_test.id('op');
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_op');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('op'), rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('b_op'), rls_test.id('company_b'), rls_test.id('role_super_admin'));
insert into public.suppliers (id, company_id, supplier_code, legal_name, gstin, state_code, payment_terms, status) values
  (rls_test.id('s_intra'), rls_test.id('company_a'), 'S-INTRA', 'Pune Ceramics', '27AAPFU0939F1ZV', '27', 'DAYS_30', 'ACTIVE'),
  (rls_test.id('s_inter'), rls_test.id('company_a'), 'S-INTER', 'Morbi Tiles', '24ABCDE1234F1Z5', '24', 'DAYS_45', 'ACTIVE'),
  (rls_test.id('s_unreg'), rls_test.id('company_a'), 'S-UNREG', 'Local Trader', null, '27', 'IMMEDIATE', 'ACTIVE');
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, track_batches, track_expiry, status, hsn_code, gst_rate, standard_cost) values
  (rls_test.id('basin'), rls_test.id('company_a'), 'PG-BASIN', 'Wash basin', 'FINISHED_GOOD', 'OUTSOURCED', 'PCS', false, false, 'ACTIVE', '6910', 18, 950),
  (rls_test.id('clay'),  rls_test.id('company_a'), 'PG-CLAY', 'Ball clay', 'RAW_MATERIAL', 'OUTSOURCED', 'KG', false, false, 'ACTIVE', '2508', 5, 12),
  (rls_test.id('valve'), rls_test.id('company_a'), 'PG-VALVE', 'Fill valve', 'COMPONENT', 'OUTSOURCED', 'PCS', false, false, 'ACTIVE', null, null, null);
insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Main', true), (rls_test.id('w2'), rls_test.id('company_a'), 'W2', 'Second', false),
  (rls_test.id('wb'), rls_test.id('company_b'), 'W1', 'B main', true);
insert into public.inventory_locations (id, company_id, warehouse_id, location_code, location_name, location_type, stock_usage) values
  (rls_test.id('rej'), rls_test.id('company_a'), rls_test.id('w1'), 'REJECT', 'Rejected bay', 'AREA', 'REJECTED');
insert into rls_test.ids (key, id)
select case warehouse_id when rls_test.id('w1') then 'g1' when rls_test.id('w2') then 'g2' else 'gb' end, id
from public.inventory_locations where location_code = 'GENERAL' and warehouse_id in (rls_test.id('w1'), rls_test.id('w2'), rls_test.id('wb'));

-- ---------------------------------------------------------------------------
-- 1. PO calculations
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('po: intra-state order with a % discount, an amount discount and a freight charge', 'po1',
  rls_test.save_po(jsonb_build_object('supplier_id', rls_test.id('s_intra'), 'purchase_type', 'RAW_MATERIAL', 'warehouse_id', rls_test.id('w1'),
      'expected_delivery_date', (rls_test.today() + 10)::text, 'payment_terms', 'DAYS_45'),
    jsonb_build_array(
      jsonb_build_object('product_id', rls_test.id('basin'), 'quantity', 10, 'unit_price', 1000, 'discount_percent', 10),
      jsonb_build_object('product_id', rls_test.id('clay'), 'quantity', 100, 'unit_price', 12, 'discount_amount', 50),
      jsonb_build_object('line_type', 'CHARGE', 'description', 'Freight', 'unit', 'NOS', 'quantity', 1, 'unit_price', 500, 'gst_rate', 18, 'hsn_sac', '996511'))));
reset role;
select rls_test.ok('calc: basin 10 x 1000 - 10% = 9000 taxable, CGST 810 + SGST 810, line total 10620; GST rate taken from the product',
  (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).taxable_value = 9000 and (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).cgst_amount = 810
  and (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).sgst_amount = 810 and (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).line_total = 10620
  and (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).gst_rate = 18);
select rls_test.ok('calc: clay 100 x 12 - 50 = 1150 taxable, 5% GST = 28.75 + 28.75, line total 1207.50',
  (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).taxable_value = 1150 and (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).cgst_amount = 28.75
  and (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).line_total = 1207.50);
select rls_test.ok('calc: totals — gross 11700, discount 1050, taxable 10650 incl. 500 freight, CGST = SGST 883.75, grand total 12417.50; payment terms 45 days',
  (rls_test.po(rls_test.gid('po1', 'po_id'))).gross_total = 11700 and (rls_test.po(rls_test.gid('po1', 'po_id'))).discount_total = 1050
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).taxable_total = 10650 and (rls_test.po(rls_test.gid('po1', 'po_id'))).other_charges_total = 500
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).cgst_total = 883.75 and (rls_test.po(rls_test.gid('po1', 'po_id'))).sgst_total = 883.75
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).igst_total = 0 and (rls_test.po(rls_test.gid('po1', 'po_id'))).grand_total = 12417.50
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).payment_terms = 'DAYS_45', to_jsonb(rls_test.po(rls_test.gid('po1', 'po_id')))::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('po: inter-state supplier', 'po2',
  rls_test.save_po(jsonb_build_object('supplier_id', rls_test.id('s_inter'), 'purchase_type', 'FINISHED_GOODS', 'warehouse_id', rls_test.id('w1')),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('basin'), 'quantity', 5, 'unit_price', 999.99))));
select rls_test.expect_call_ok('po: unregistered supplier', 'po3',
  rls_test.save_po(jsonb_build_object('supplier_id', rls_test.id('s_unreg'), 'purchase_type', 'RAW_MATERIAL', 'warehouse_id', rls_test.id('w1')),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('clay'), 'quantity', 10, 'unit_price', 12))));
reset role;
select rls_test.ok('calc: inter-state -> IGST only: 5 x 999.99 = 4999.95 + 18% = 899.99, total 5899.94',
  (rls_test.po(rls_test.gid('po2', 'po_id'))).tax_treatment = 'INTER_STATE' and (rls_test.po(rls_test.gid('po2', 'po_id'))).igst_total = 899.99
  and (rls_test.po(rls_test.gid('po2', 'po_id'))).cgst_total = 0 and (rls_test.po(rls_test.gid('po2', 'po_id'))).grand_total = 5899.94,
  to_jsonb(rls_test.po(rls_test.gid('po2', 'po_id')))::text);
select rls_test.ok('calc: unregistered supplier -> no GST: 10 x 12 = 120',
  (rls_test.po(rls_test.gid('po3', 'po_id'))).tax_treatment = 'NO_GST' and (rls_test.po(rls_test.gid('po3', 'po_id'))).grand_total = 120);

-- ---------------------------------------------------------------------------
-- 2. Open without approval; nothing in stock until goods are received
-- ---------------------------------------------------------------------------
select rls_test.set('tx_start', to_jsonb(rls_test.tx_count(rls_test.id('company_a'))));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('receipt: goods cannot be received on a draft', format('select public.purchase_receipt_post(%L, %L::jsonb, %L::jsonb, %L)',
  rls_test.gid('po1', 'po_id'), '{}', jsonb_build_array(rls_test.rl(rls_test.id('basin'), 1, 1)), gen_random_uuid()), 'approved order');
select rls_test.expect_call_ok('open: the operator opens PO 1 in one step', 'po1_open', format('select public.purchase_order_open(%L)', rls_test.gid('po1', 'po_id')));
select rls_test.call(format('select public.purchase_order_open(%L)', rls_test.gid('po2', 'po_id')));
reset role;
select rls_test.ok('open: an open order adds no stock (incoming only)',
  rls_test.on_hand(rls_test.id('basin')) = 0 and rls_test.on_hand(rls_test.id('clay')) = 0
  and rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx_start'))::bigint and (rls_test.po(rls_test.gid('po1', 'po_id'))).status = 'APPROVED'
  and (rls_test.qty(rls_test.gid('po1', 'po_id'), 1) ->> 'pending')::numeric = 10);
insert into rls_test.ids values ('l_basin', (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).id), ('l_clay', (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).id),
  ('l_charge', (rls_test.line(rls_test.gid('po1', 'po_id'), 3)).id), ('l2_basin', (rls_test.line(rls_test.gid('po2', 'po_id'), 1)).id);

-- ---------------------------------------------------------------------------
-- 3. Partial and multiple receipts
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('receipt: charge lines are not received', format('select public.purchase_receipt_post(%L, %L::jsonb, %L::jsonb, %L)',
  rls_test.gid('po1', 'po_id'), '{}', jsonb_build_array(rls_test.rl(rls_test.id('l_charge'), 1, 1)), gen_random_uuid()), 'charge');
select rls_test.expect_call_error('receipt: accepted + rejected must equal received', format('select public.purchase_receipt_post(%L, %L::jsonb, %L::jsonb, %L)',
  rls_test.gid('po1', 'po_id'), '{}', jsonb_build_array(rls_test.rl(rls_test.id('l_basin'), 4, 2, 1, rls_test.id('g1'), 'Cracked')), gen_random_uuid()), 'must equal');
select rls_test.expect_call_error('receipt: a rejected quantity needs a reason', format('select public.purchase_receipt_post(%L, %L::jsonb, %L::jsonb, %L)',
  rls_test.gid('po1', 'po_id'), '{}', jsonb_build_array(rls_test.rl(rls_test.id('l_basin'), 4, 3, 1, rls_test.id('g1'))), gen_random_uuid()), 'reason');
select rls_test.expect_call_error('receipt: accepted goods must go to a storage location of the order''s warehouse',
  format('select public.purchase_receipt_post(%L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('po1', 'po_id'), '{}',
    jsonb_build_array(rls_test.rl(rls_test.id('l_basin'), 1, 1, 0, rls_test.id('g2'))), gen_random_uuid()), 'storage location');
select rls_test.expect_call_ok('receipt 1: basin 4 received (3 accepted, 1 cracked, recorded only) and 60 KG clay', 'grn1',
  format('select public.purchase_receipt_post(%L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('po1', 'po_id'),
    jsonb_build_object('receipt_date', rls_test.today()::text, 'supplier_document_number', 'INV-77'),
    jsonb_build_array(rls_test.rl(rls_test.id('l_basin'), 4, 3, 1, rls_test.id('g1'), 'Cracked in transit'), rls_test.rl(rls_test.id('l_clay'), 60, 60, 0, rls_test.id('g1'))),
    'e7e5c400-0000-4000-8000-00000000a001'));
reset role;
select rls_test.ok('receipt 1: stock rises only by the accepted quantities (basin 3, clay 60); the cracked basin is not stock',
  rls_test.on_hand(rls_test.id('basin')) = 3 and rls_test.on_hand(rls_test.id('clay')) = 60 and rls_test.available(rls_test.id('basin')) = 3);
select rls_test.ok('receipt 1: basin ordered 10, received 4, accepted 3, rejected 1, pending 7; clay pending 40; PO partially received',
  rls_test.qty(rls_test.gid('po1', 'po_id'), 1) = '{"ordered": 10.000, "received": 4, "accepted": 3, "rejected": 1, "pending": 7}'::jsonb
  and (rls_test.qty(rls_test.gid('po1', 'po_id'), 2) ->> 'pending')::numeric = 40 and (rls_test.po(rls_test.gid('po1', 'po_id'))).status = 'PARTIALLY_RECEIVED',
  concat_ws(' | ', rls_test.qty(rls_test.gid('po1', 'po_id'), 1), rls_test.qty(rls_test.gid('po1', 'po_id'), 2)));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('receipt 1: a retry with the same request id', 'grn1_retry',
  format('select public.purchase_receipt_post(%L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('po1', 'po_id'), '{}',
    jsonb_build_array(rls_test.rl(rls_test.id('l_basin'), 4, 3, 1, rls_test.id('g1'), 'Cracked in transit'), rls_test.rl(rls_test.id('l_clay'), 60, 60, 0, rls_test.id('g1'))),
    'e7e5c400-0000-4000-8000-00000000a001'));
reset role;
select rls_test.ok('receipt 1: ...posts nothing twice', rls_test.on_hand(rls_test.id('basin')) = 3 and rls_test.on_hand(rls_test.id('clay')) = 60
  and rls_test.get('grn1_retry') ->> 'receipt_id' = rls_test.get('grn1') ->> 'receipt_id');
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('receipt 2: the remaining 7 basins and 40 KG clay', 'grn2',
  format('select public.purchase_receipt_post(%L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('po1', 'po_id'), '{}',
    jsonb_build_array(rls_test.rl(rls_test.id('l_basin'), 7, 7, 0, rls_test.id('g1')), rls_test.rl(rls_test.id('l_clay'), 40, 40, 0, rls_test.id('g1'))), gen_random_uuid()));
reset role;
select rls_test.ok('receipt 2: stock basin 10, clay 100; nothing pending; PO fully received',
  rls_test.on_hand(rls_test.id('basin')) = 10 and rls_test.on_hand(rls_test.id('clay')) = 100
  and (rls_test.qty(rls_test.gid('po1', 'po_id'), 1) ->> 'pending')::numeric = 0 and (rls_test.qty(rls_test.gid('po1', 'po_id'), 2) ->> 'pending')::numeric = 0
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).status = 'RECEIVED');
select rls_test.ok('list: order totals — 110 ordered (charges excluded), 110 accepted, 0 pending, 2 receipts',
  (select total_ordered_quantity = 110 and total_accepted_quantity = 110 and total_pending_quantity = 0 and receipt_count = 2
   from public.purchase_order_list where id = rls_test.gid('po1', 'po_id')));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('receipt: a fully received order accepts no more receipts',
  format('select public.purchase_receipt_post(%L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('po1', 'po_id'), '{}',
    jsonb_build_array(rls_test.rl(rls_test.id('l_basin'), 1, 1, 0, rls_test.id('g1'))), gen_random_uuid()), 'approved order');
select rls_test.expect_call_error('over-receipt: receiving more than pending needs a documented reason',
  format('select public.purchase_receipt_post(%L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('po2', 'po_id'), '{}',
    jsonb_build_array(rls_test.rl(rls_test.id('l2_basin'), 6, 6, 0, rls_test.id('g1'))), gen_random_uuid()), 'reason');
select rls_test.expect_call_ok('over-receipt: with a reason, 6 of 5 are received', 'grn_over',
  format('select public.purchase_receipt_post(%L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('po2', 'po_id'), '{}',
    jsonb_build_array(rls_test.rl(rls_test.id('l2_basin'), 6, 6, 0, rls_test.id('g1'), null, null, 'Supplier sent one extra, kept')), gen_random_uuid()));
reset role;
select rls_test.ok('over-receipt: pending never goes negative (0); stock basin 16; order fully received',
  (rls_test.qty(rls_test.gid('po2', 'po_id'), 1) ->> 'pending')::numeric = 0 and rls_test.on_hand(rls_test.id('basin')) = 16
  and (rls_test.po(rls_test.gid('po2', 'po_id'))).status = 'RECEIVED');

-- ---------------------------------------------------------------------------
-- 4. Reversal and correction
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('reversal: a reason is required', format('select public.goods_receipt_reverse(%L, %L, %L)', rls_test.gid('grn2', 'receipt_id'), 'x', gen_random_uuid()), 'reason');
select rls_test.expect_call_ok('reversal: receipt 2 reversed', 'grn2_rev', format('select public.goods_receipt_reverse(%L, %L, %L)', rls_test.gid('grn2', 'receipt_id'), 'Posted to the wrong order', gen_random_uuid()));
reset role;
select rls_test.ok('reversal: stock back to basin 9 (16 - 7) and clay 60; pending 7 / 40 again; PO partially received; receipt kept as REVERSED with 2 reversal postings',
  rls_test.on_hand(rls_test.id('basin')) = 9 and rls_test.on_hand(rls_test.id('clay')) = 60
  and (rls_test.qty(rls_test.gid('po1', 'po_id'), 1) ->> 'pending')::numeric = 7 and (rls_test.qty(rls_test.gid('po1', 'po_id'), 2) ->> 'pending')::numeric = 40
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).status = 'PARTIALLY_RECEIVED' and (rls_test.grn(rls_test.gid('grn2', 'receipt_id'))).status = 'REVERSED'
  and cardinality((rls_test.grn(rls_test.gid('grn2', 'receipt_id'))).reversal_transaction_ids) = 2);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('reversal: a reversed receipt cannot be reversed again',
  format('select public.goods_receipt_reverse(%L, %L, %L)', rls_test.gid('grn2', 'receipt_id'), 'Again please', gen_random_uuid()), 'already been reversed');
select rls_test.expect_call_error('reversal: the generic stock reversal refuses goods receipt postings',
  format('select public.inventory_reverse_transaction((select accepted_transaction_id from public.goods_receipt_lines where goods_receipt_id = %L limit 1), %L, %L)',
    rls_test.gid('grn1', 'receipt_id'), 'Not here', gen_random_uuid()), 'goods receipt');
select rls_test.set('tx_before_bad', to_jsonb(rls_test.tx_count(rls_test.id('company_a'))));
select rls_test.expect_call_error('correction: an invalid corrected receipt changes nothing (all or nothing)',
  format('select public.goods_receipt_correct(%L, %L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('grn1', 'receipt_id'), 'Wrong quantities', '{}',
    jsonb_build_array(rls_test.rl(rls_test.id('l_basin'), 5, 2, 0, rls_test.id('g1'))), gen_random_uuid()), 'must equal');
reset role;
select rls_test.ok('correction: after the failed attempt receipt 1 is still posted and no stock moved',
  (rls_test.grn(rls_test.gid('grn1', 'receipt_id'))).status = 'POSTED' and rls_test.on_hand(rls_test.id('basin')) = 9
  and rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx_before_bad'))::bigint);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('correction: receipt 1 corrected to 5 basins (all accepted) and 55 KG clay', 'grn1_fix',
  format('select public.goods_receipt_correct(%L, %L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('grn1', 'receipt_id'), 'Counted again at the gate', '{}',
    jsonb_build_array(rls_test.rl(rls_test.id('l_basin'), 5, 5, 0, rls_test.id('g1')), rls_test.rl(rls_test.id('l_clay'), 55, 55, 0, rls_test.id('g1'))), gen_random_uuid()));
reset role;
select rls_test.ok('correction: stock basin 11 (9 - 3 + 5), clay 55 (60 - 60 + 55); pending basin 5, clay 45',
  rls_test.on_hand(rls_test.id('basin')) = 11 and rls_test.on_hand(rls_test.id('clay')) = 55
  and (rls_test.qty(rls_test.gid('po1', 'po_id'), 1) ->> 'pending')::numeric = 5 and (rls_test.qty(rls_test.gid('po1', 'po_id'), 2) ->> 'pending')::numeric = 45,
  concat_ws(' | ', rls_test.on_hand(rls_test.id('basin')), rls_test.on_hand(rls_test.id('clay'))));
select rls_test.ok('correction: the original is REVERSED, the new receipt points at it, keeps its date and supplier document, and the order history shows the correction',
  (rls_test.grn(rls_test.gid('grn1', 'receipt_id'))).status = 'REVERSED'
  and (rls_test.grn(rls_test.gid('grn1_fix', 'receipt_id'))).corrects_receipt_id = rls_test.gid('grn1', 'receipt_id')
  and (rls_test.grn(rls_test.gid('grn1_fix', 'receipt_id'))).supplier_document_number = 'INV-77'
  and (rls_test.grn(rls_test.gid('grn1_fix', 'receipt_id'))).receipt_date = rls_test.today()
  and 'RECEIPT_CORRECTED' = any (rls_test.events(rls_test.gid('po1', 'po_id'))) and rls_test.get('grn1_fix') ->> 'corrects_receipt_number' like 'GRN-%');

-- ---------------------------------------------------------------------------
-- 5. Direct (unlinked) goods receipts
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('direct: 25 KG clay from the intra-state supplier into W2, cost and GST from the product', 'd1',
  format('select public.goods_receipt_direct_post(%L::jsonb, %L::jsonb, %L)',
    jsonb_build_object('supplier_id', rls_test.id('s_intra'), 'warehouse_id', rls_test.id('w2'), 'supplier_document_number', 'CH-9', 'notes', 'Urgent top-up'),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('clay'), 'received_quantity', 25, 'accepted_location_id', rls_test.id('g2'))), gen_random_uuid()));
reset role;
select rls_test.ok('direct: stock clay 80 (25 in W2); receipt type DIRECT, no PO; the result warns it is unlinked; value 25 x 12 + 5% = 315.00',
  rls_test.on_hand(rls_test.id('clay')) = 80 and rls_test.on_hand(rls_test.id('clay'), rls_test.id('g2')) = 25
  and (rls_test.grn(rls_test.gid('d1', 'receipt_id'))).receipt_type = 'DIRECT' and (rls_test.grn(rls_test.gid('d1', 'receipt_id'))).purchase_order_id is null
  and (rls_test.get('d1') ->> 'unlinked')::boolean and rls_test.get('d1') -> 'warnings' ->> 0 like '%not linked to a purchase order%'
  and (select line_value = 315 and unit_cost = 12 and gst_rate = 5 from public.goods_receipt_lines where goods_receipt_id = rls_test.gid('d1', 'receipt_id')),
  rls_test.get('d1')::text);
select rls_test.ok('direct: the receipt list shows supplier and warehouse; the line list shows the SKU',
  (select supplier_name = 'Pune Ceramics' and warehouse_code = 'W2' and po_number is null and total_accepted = 25 from public.goods_receipt_list where id = rls_test.gid('d1', 'receipt_id'))
  and (select sku = 'PG-CLAY' and po_line_no is null from public.goods_receipt_line_list where goods_receipt_id = rls_test.gid('d1', 'receipt_id')));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('direct: no supplier and a product without a cost is still accepted (with warnings); 2 good, 1 damaged kept in the rejected bay', 'd2',
  format('select public.goods_receipt_direct_post(%L::jsonb, %L::jsonb, %L)', jsonb_build_object('warehouse_id', rls_test.id('w1')),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('valve'), 'received_quantity', 3, 'accepted_quantity', 2, 'rejected_quantity', 1,
      'rejection_reason', 'Broken float', 'accepted_location_id', rls_test.id('g1'), 'rejected_location_id', rls_test.id('rej'))), gen_random_uuid()));
reset role;
select rls_test.ok('direct: valves 3 on hand but only 2 available (the damaged one sits in the rejected bay); warnings about supplier and cost',
  rls_test.on_hand(rls_test.id('valve')) = 3 and rls_test.available(rls_test.id('valve')) = 2 and rls_test.on_hand(rls_test.id('valve'), rls_test.id('rej')) = 1
  and jsonb_array_length(rls_test.get('d2') -> 'warnings') = 3, rls_test.get('d2')::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('direct: a warehouse is required', format('select public.goods_receipt_direct_post(%L::jsonb, %L::jsonb, %L)', '{}',
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('clay'), 'received_quantity', 1, 'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()), 'warehouse');
select rls_test.expect_call_error('direct: the location must belong to the chosen warehouse',
  format('select public.goods_receipt_direct_post(%L::jsonb, %L::jsonb, %L)', jsonb_build_object('warehouse_id', rls_test.id('w2')),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('clay'), 'received_quantity', 1, 'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()), 'storage location');
select rls_test.expect_call_error('direct: whole-piece items need whole quantities',
  format('select public.goods_receipt_direct_post(%L::jsonb, %L::jsonb, %L)', jsonb_build_object('warehouse_id', rls_test.id('w1')),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('valve'), 'received_quantity', 1.5, 'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()), 'whole');
-- Payable: PO receipts at PO line value incl. GST + direct receipt value.
select rls_test.ok('payable: Pune Ceramics owes = corrected receipt (5/10 x 10620 + 55/100 x 1207.50 = 5310 + 664.13) + direct 315 = 6289.13',
  (select payable = 6289.13 from public.ledger_parties(null, null, null) where supplier_id = rls_test.id('s_intra')),
  (select payable::text from public.ledger_parties(null, null, null) where supplier_id = rls_test.id('s_intra')));
select rls_test.ok('history: the direct receipt appears in the supplier''s ledger history as received without a purchase order',
  exists (select 1 from jsonb_array_elements(public.party_transactions((select party_id from public.ledger_parties(null, null, null) where supplier_id = rls_test.id('s_intra'))) -> 'entries') e
          where e ->> 'document' = rls_test.get('d1') ->> 'receipt_number' and e ->> 'description' like 'Goods received without a purchase order%' and (e ->> 'payable')::numeric = 315));
select rls_test.expect_call_ok('direct correction: 25 KG was really 20 KG at 11', 'd1_fix',
  format('select public.goods_receipt_correct(%L, %L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('d1', 'receipt_id'), 'Weighbridge slip checked', '{}',
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('clay'), 'received_quantity', 20, 'unit_cost', 11, 'accepted_location_id', rls_test.id('g2'))), gen_random_uuid()));
reset role;
select rls_test.ok('direct correction: clay 75 (20 in W2); the new direct receipt keeps supplier and warehouse; value 20 x 11 + 5% = 231.00',
  rls_test.on_hand(rls_test.id('clay')) = 75 and rls_test.on_hand(rls_test.id('clay'), rls_test.id('g2')) = 20
  and (rls_test.grn(rls_test.gid('d1_fix', 'receipt_id'))).supplier_id = rls_test.id('s_intra') and (rls_test.grn(rls_test.gid('d1_fix', 'receipt_id'))).warehouse_id = rls_test.id('w2')
  and (select line_value = 231 from public.goods_receipt_lines where goods_receipt_id = rls_test.gid('d1_fix', 'receipt_id')));
-- Stock already used cannot be received back out.
set local role authenticated;
select rls_test.claims('op');
select rls_test.call(format($q$ select public.inventory_post_issue(%L, %L, 2, p_reason => 'Workshop use', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('valve'), rls_test.id('g1')));
select rls_test.expect_call_error('reversal: refused when the received goods have already been used (stock never goes negative)',
  format('select public.goods_receipt_reverse(%L, %L, %L)', rls_test.gid('d2', 'receipt_id'), 'Supplier took them back', gen_random_uuid()), 'Insufficient');
reset role;
select rls_test.ok('reversal: ...and the receipt stays posted', (rls_test.grn(rls_test.gid('d2', 'receipt_id'))).status = 'POSTED');

-- ---------------------------------------------------------------------------
-- 6. Delivery date and notes of an open order; attachments
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('details: the delivery date of an open order is moved without a new revision', 'det',
  format('select public.purchase_order_update_details(%L, %L::jsonb)', rls_test.gid('po1', 'po_id'),
    jsonb_build_object('expected_delivery_date', (rls_test.today() + 20)::text, 'delivery_instructions', 'Gate 2 only')));
reset role;
select rls_test.ok('details: date and instructions saved, revision unchanged, change recorded in the order history',
  (rls_test.po(rls_test.gid('po1', 'po_id'))).expected_delivery_date = rls_test.today() + 20 and (rls_test.po(rls_test.gid('po1', 'po_id'))).delivery_instructions = 'Gate 2 only'
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).revision = 0 and 'DETAILS_UPDATED' = any (rls_test.events(rls_test.gid('po1', 'po_id'))));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('details: prices and quantities need an amendment, not this function',
  format('select public.purchase_order_update_details(%L, %L::jsonb)', rls_test.gid('po1', 'po_id'), '{"grand_total": 1}'), 'new revision');
select rls_test.expect_call_error('details: the delivery date cannot be before the PO date',
  format('select public.purchase_order_update_details(%L, %L::jsonb)', rls_test.gid('po1', 'po_id'), jsonb_build_object('expected_delivery_date', (rls_test.today() - 400)::text)), 'before the PO date');
select rls_test.ok('attachments: purchase orders and goods receipts can be found for attaching documents',
  public.document_entity_search('SUPPLIER_PO', (rls_test.po(rls_test.gid('po1', 'po_id'))).po_number) -> 0 ->> 'id' = rls_test.get('po1') ->> 'po_id'
  and public.document_entity_search('GOODS_RECEIPT', rls_test.get('d1') ->> 'receipt_number') -> 0 ->> 'id' = rls_test.get('d1') ->> 'receipt_id');

-- ---------------------------------------------------------------------------
-- 7. Ledger integrity and isolation
-- ---------------------------------------------------------------------------
reset role;
select rls_test.ok('ledger: every stock balance equals the sum of its postings (receipts, reversals, corrections, issue)',
  rls_test.ledger_consistent(rls_test.id('company_a')));
set local role authenticated;
select rls_test.claims('b_op');
select rls_test.expect_call_error('isolation: company B cannot receive into company A''s warehouse',
  format('select public.goods_receipt_direct_post(%L::jsonb, %L::jsonb, %L)', jsonb_build_object('warehouse_id', rls_test.id('w1')),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('clay'), 'received_quantity', 1, 'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()), 'warehouse');
select rls_test.expect_call_error('isolation: company B cannot reverse company A''s receipt',
  format('select public.goods_receipt_reverse(%L, %L, %L)', rls_test.gid('grn1_fix', 'receipt_id'), 'Not mine to touch', gen_random_uuid()), 'not found');
select rls_test.expect_call_error('isolation: ...nor change its order',
  format('select public.purchase_order_update_details(%L, %L::jsonb)', rls_test.gid('po1', 'po_id'), '{"internal_notes": "x"}'), 'not found');
select rls_test.ok('isolation: company B sees none of company A''s receipts', not exists (select 1 from public.goods_receipt_list));
reset role;
select rls_test.ok('grants: anon cannot call the new receipt functions',
  not has_function_privilege('anon', 'public.goods_receipt_direct_post(jsonb, jsonb, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.goods_receipt_correct(uuid, text, jsonb, jsonb, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.goods_receipt_reverse(uuid, text, uuid)', 'EXECUTE'));

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
  raise exception 'PURCHASING_V2_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
