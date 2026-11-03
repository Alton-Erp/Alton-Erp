-- =============================================================================
-- SUPPLIER PURCHASE ORDERS & GOODS RECEIPTS VERIFICATION
--
-- Executable checks for PO creation and numbering, GST (intra-state, inter-state,
-- unregistered supplier, missing company GSTIN, 0.25% rate, round-off), input
-- validation, the approval workflow and segregation of duties, partial and
-- over-receipts, rejected goods, atomic posting and retried requests, inventory
-- ledger reconciliation, amendment, cancellation / short-close, receipt reversal,
-- permissions, RLS, cross-company isolation, audit and the dashboard.
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction with its own companies (SPOA / SPOB) and ALWAYS ends
-- by raising PURCHASE_ORDER_VERIFICATION_RESULT passed=N failed=M so that all
-- test rows are rolled back.
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
create function rls_test.expect_rows(p_name text, p_sql text, p_expected int) returns void language plpgsql as $$
declare n int;
begin execute format('select count(*) from (%s) q', p_sql) into n;
  perform rls_test.ok(p_name, n = p_expected, format('rows=%s expected=%s', n, p_expected));
exception when others then perform rls_test.ok(p_name, false, format('unexpected error %s: %s', sqlstate, sqlerrm)); end $$;
create function rls_test.expect_error(p_name text, p_sql text, p_state text default null) returns void language plpgsql as $$
begin execute p_sql; perform rls_test.ok(p_name, false, 'statement succeeded but should have been rejected');
exception when others then perform rls_test.ok(p_name, p_state is null or sqlstate = p_state, format('rejected %s: %s', sqlstate, sqlerrm)); end $$;
create function rls_test.expect_call_ok(p_name text, p_key text, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.set(p_key, r); perform rls_test.ok(p_name, not (r ? 'error'), r::text); return r; end $$;
create function rls_test.expect_call_error(p_name text, p_sql text, p_pattern text default null, p_state text default null) returns void language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.ok(p_name, r ? 'error' and (p_pattern is null or r ->> 'error' ilike '%' || p_pattern || '%')
  and (p_state is null or r ->> 'sqlstate' = p_state), r::text); end $$;
create function rls_test.claims(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', rls_test.id(p_key), 'role', 'authenticated')::text, true) $$;

-- SQL builders
create function rls_test.save(p_po uuid, p_header jsonb, p_lines jsonb, p_key uuid default null) returns text language sql immutable as $$
  select format('select public.purchase_order_save(%L, %L::jsonb, %L::jsonb, null, %L)', p_po, p_header, p_lines, p_key) $$;
create function rls_test.act(p_po uuid, p_action text, p_note text default null) returns text language sql immutable as $$
  select format('select public.purchase_order_action(%L, %L, %L)', p_po, p_action, p_note) $$;
create function rls_test.receive(p_po uuid, p_lines jsonb, p_key uuid, p_header jsonb default '{}'::jsonb) returns text language sql immutable as $$
  select format('select public.purchase_receipt_post(%L, %L::jsonb, %L::jsonb, %L)', p_po, p_header, p_lines, p_key) $$;

-- Owner-side probes
create function rls_test.po(p_id uuid) returns public.purchase_orders language sql stable security definer as $$
  select * from public.purchase_orders where id = p_id $$;
create function rls_test.line(p_po uuid, p_no int) returns public.purchase_order_lines language sql stable security definer as $$
  select * from public.purchase_order_lines where purchase_order_id = p_po and line_no = p_no $$;
create function rls_test.on_hand(p_product uuid, p_location uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(on_hand), 0) from public.inventory_balances where product_id = p_product and location_id = p_location $$;
create function rls_test.po_ledger_net(p_po uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(direction * quantity), 0) from public.inventory_transactions where reference_type = 'PURCHASE_ORDER' and reference_id = p_po $$;
create function rls_test.po_posted_qty(p_po uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(case when l.accepted_transaction_id is not null then l.accepted_quantity else 0 end
                    + case when l.rejected_transaction_id is not null then l.rejected_quantity else 0 end), 0)
  from public.goods_receipt_lines l join public.goods_receipts r on r.id = l.goods_receipt_id where r.purchase_order_id = p_po and r.status = 'POSTED' $$;
create function rls_test.count_tx(p_po uuid) returns int language sql stable security definer as $$
  select count(*)::int from public.inventory_transactions where reference_type = 'PURCHASE_ORDER' and reference_id = p_po $$;
create function rls_test.count_receipts(p_po uuid) returns int language sql stable security definer as $$
  select count(*)::int from public.goods_receipts where purchase_order_id = p_po $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e57600-0000-4000-8000-0000000000a1'), ('company_b', 'e7e57600-0000-4000-8000-0000000000b1'),
  ('pm', 'e7e57600-0000-4000-8000-000000000002'), ('pm2', 'e7e57600-0000-4000-8000-000000000003'),
  ('adm', 'e7e57600-0000-4000-8000-000000000004'), ('inv', 'e7e57600-0000-4000-8000-000000000005'),
  ('acct', 'e7e57600-0000-4000-8000-000000000006'), ('viewer', 'e7e57600-0000-4000-8000-000000000007'),
  ('sales', 'e7e57600-0000-4000-8000-000000000008'), ('sa', 'e7e57600-0000-4000-8000-000000000009'),
  ('b_pm', 'e7e57600-0000-4000-8000-00000000000b'),
  ('s_intra', 'e7e57600-0000-4000-8000-0000000000c1'), ('s_inter', 'e7e57600-0000-4000-8000-0000000000c2'),
  ('s_unreg', 'e7e57600-0000-4000-8000-0000000000c3'), ('s_inactive', 'e7e57600-0000-4000-8000-0000000000c4'),
  ('b_sup', 'e7e57600-0000-4000-8000-0000000000c5'),
  ('basin', 'e7e57600-0000-4000-8000-0000000000d1'), ('clay', 'e7e57600-0000-4000-8000-0000000000d2'),
  ('old', 'e7e57600-0000-4000-8000-0000000000d3'), ('b_prod', 'e7e57600-0000-4000-8000-0000000000d4'),
  ('w1', 'e7e57600-0000-4000-8000-0000000000e1'), ('w2', 'e7e57600-0000-4000-8000-0000000000e2'), ('wb', 'e7e57600-0000-4000-8000-0000000000e3'),
  ('rej', 'e7e57600-0000-4000-8000-0000000000f1');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code, gstin, legal_address) values
  (rls_test.id('company_a'), 'PO Buyer A Pvt Ltd', 'PO Buyer A', 'SPOA', '27AAACA1234A1Z5', 'Plot 1, MIDC, Pune 411026'),
  (rls_test.id('company_b'), 'PO Buyer B', 'PO Buyer B', 'SPOB', null, null);
-- V2 turns segregation of duties off by default (single operator). This suite tests it, so it switches it on.
insert into public.company_settings (company_id, setting_key, setting_value)
select id, 'inventory.segregation_of_duties', 'true'::jsonb from public.companies where id in (rls_test.id('company_a'), rls_test.id('company_b'));
insert into auth.users (id, email) select id, key || '@spo.example.invalid' from rls_test.ids
  where key in ('pm', 'pm2', 'adm', 'inv', 'acct', 'viewer', 'sales', 'sa', 'b_pm');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true
  where id in (select id from rls_test.ids where key in ('pm', 'pm2', 'adm', 'inv', 'acct', 'viewer', 'sales', 'sa'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_pm');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('pm'),     rls_test.id('company_a'), rls_test.id('role_purchase_manager')),
  (rls_test.id('pm2'),    rls_test.id('company_a'), rls_test.id('role_purchase_manager')),
  (rls_test.id('adm'),    rls_test.id('company_a'), rls_test.id('role_admin')),
  (rls_test.id('inv'),    rls_test.id('company_a'), rls_test.id('role_inventory_manager')),
  (rls_test.id('acct'),   rls_test.id('company_a'), rls_test.id('role_accounts_manager')),
  (rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_management_viewer')),
  (rls_test.id('sales'),  rls_test.id('company_a'), rls_test.id('role_sales_manager')),
  (rls_test.id('sa'),     rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('b_pm'),   rls_test.id('company_b'), rls_test.id('role_purchase_manager'));

insert into public.suppliers (id, company_id, supplier_code, legal_name, gstin, state_code, payment_terms, status, billing_address) values
  (rls_test.id('s_intra'), rls_test.id('company_a'), 'S-INTRA', 'Pune Ceramics Pvt Ltd', '27AAPFU0939F1ZV', '27', 'DAYS_30', 'ACTIVE', 'Bhosari, Pune'),
  (rls_test.id('s_inter'), rls_test.id('company_a'), 'S-INTER', 'Morbi Tiles LLP', '24ABCDE1234F1Z5', '24', 'DAYS_45', 'ACTIVE', 'Morbi, Gujarat'),
  (rls_test.id('s_unreg'), rls_test.id('company_a'), 'S-UNREG', 'Local Carrier', null, '27', 'IMMEDIATE', 'ACTIVE', null),
  (rls_test.id('s_inactive'), rls_test.id('company_a'), 'S-OLD', 'Old Vendor', null, '27', 'DAYS_30', 'INACTIVE', null),
  (rls_test.id('b_sup'), rls_test.id('company_b'), 'S-B', 'B Supplier', '29AAPFU0939F1ZW', '29', 'DAYS_30', 'ACTIVE', null);

insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, track_batches, track_expiry, status,
  hsn_code, gst_rate, standard_cost) values
  (rls_test.id('basin'), rls_test.id('company_a'), 'PO-BASIN', 'Wash basin', 'FINISHED_GOOD', 'OUTSOURCED', 'PCS', false, false, 'ACTIVE', '6910', 18, 950),
  (rls_test.id('clay'), rls_test.id('company_a'), 'PO-CLAY', 'Ball clay', 'RAW_MATERIAL', 'IN_HOUSE', 'KG', true, false, 'ACTIVE', '2508', 5, null),
  (rls_test.id('old'), rls_test.id('company_a'), 'PO-OLD', 'Old basin', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, 'INACTIVE', null, 18, null),
  (rls_test.id('b_prod'), rls_test.id('company_b'), 'PO-BASIN', 'B basin', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, 'ACTIVE', null, 18, null);

insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default, address) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Main', true, 'Gate 2, MIDC Bhosari'), (rls_test.id('w2'), rls_test.id('company_a'), 'W2', 'Second', false, null),
  (rls_test.id('wb'), rls_test.id('company_b'), 'W1', 'B main', true, null);
insert into public.inventory_locations (id, company_id, warehouse_id, location_code, location_name, location_type, stock_usage) values
  (rls_test.id('rej'), rls_test.id('company_a'), rls_test.id('w1'), 'REJECT', 'Rejected bay', 'AREA', 'REJECTED');
insert into rls_test.ids (key, id)
select case warehouse_id when rls_test.id('w1') then 'g1' when rls_test.id('w2') then 'g2' else 'gb' end, id
from public.inventory_locations where location_code = 'GENERAL' and warehouse_id in (rls_test.id('w1'), rls_test.id('w2'), rls_test.id('wb'));

-- ---------------------------------------------------------------------------
-- Schema, grants and permissions
-- ---------------------------------------------------------------------------
select rls_test.ok('schema: RLS enabled on all purchasing tables',
  (select bool_and(relrowsecurity) from pg_class where oid in ('public.purchase_orders'::regclass, 'public.purchase_order_lines'::regclass,
    'public.purchase_order_events'::regclass, 'public.purchase_order_amendments'::regclass, 'public.goods_receipts'::regclass, 'public.goods_receipt_lines'::regclass)));
select rls_test.ok('schema: clients cannot write purchasing tables directly',
  not exists (select 1 from unnest(array['purchase_orders', 'purchase_order_lines', 'purchase_order_events', 'purchase_order_amendments',
    'goods_receipts', 'goods_receipt_lines']) t where has_table_privilege('authenticated', 'public.' || t, 'INSERT,UPDATE,DELETE')));
select rls_test.ok('schema: anon cannot read purchasing tables or call the functions',
  not has_table_privilege('anon', 'public.purchase_orders', 'SELECT')
  and not has_function_privilege('anon', 'public.purchase_order_save(uuid, jsonb, jsonb, timestamptz, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.purchase_receipt_post(uuid, jsonb, jsonb, uuid)', 'EXECUTE'));
select rls_test.ok('permissions: 9 purchasing permissions added; no new roles',
  (select count(*) from public.permissions where code like 'purchase\_order.%' or code like 'purchase\_receipt.%' or code like 'purchase\_exception.%') = 9
  and (select count(*) from public.roles) = 8);
select rls_test.ok('permissions: role matrix (PM orders + approves; Inventory receives; Accounts export only; Viewer none; Admin approves + exceptions)',
  exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id where r.code = 'PURCHASE_MANAGER' and p.code = 'purchase_order.approve')
  and exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id where r.code = 'INVENTORY_MANAGER' and p.code = 'purchase_receipt.create')
  and not exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id where r.code = 'INVENTORY_MANAGER' and p.code like 'purchase\_order.%')
  and (select array_agg(p.code order by p.code) from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id
       where r.code = 'ACCOUNTS_MANAGER' and (p.code like 'purchase\_%')) = array['purchase_order.export']
  and not exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id where r.code = 'MANAGEMENT_VIEWER' and p.code like 'purchase\_%')
  and exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id where r.code = 'ADMIN' and p.code = 'purchase_exception.approve')
  and (select count(*) from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id where r.code = 'SUPER_ADMIN' and p.code like 'purchase%') = 11);

-- ---------------------------------------------------------------------------
-- Create (intra-state GST) and numbering
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('pm');
select rls_test.set('lines1', jsonb_build_array(
  jsonb_build_object('line_type', 'GOODS', 'product_id', rls_test.id('basin'), 'quantity', 10, 'unit_price', 1000, 'discount_percent', 10),
  jsonb_build_object('line_type', 'GOODS', 'product_id', rls_test.id('clay'), 'quantity', '2.5', 'unit_price', '333.3333', 'discount_amount', 10.5),
  jsonb_build_object('line_type', 'CHARGE', 'description', 'Freight', 'unit', 'nos', 'quantity', 1, 'unit_price', 500, 'gst_rate', 18, 'hsn_sac', '996511')));
select rls_test.set('hdr1', jsonb_build_object('supplier_id', rls_test.id('s_intra'), 'purchase_type', 'FINISHED_GOODS', 'warehouse_id', rls_test.id('w1'),
  'expected_delivery_date', (current_date + 7)::text, 'reference_number', 'QUO-17', 'company_id', rls_test.id('company_b')));
select rls_test.expect_call_ok('create: Purchase Manager creates a draft PO', 'po1',
  rls_test.save(null, rls_test.get('hdr1'), rls_test.get('lines1'), 'e7e57600-0000-4000-8000-00000000aa01'));
select rls_test.ok('create: PO-000001, DRAFT, company taken from the user (company_id in the payload ignored)',
  rls_test.get('po1') ->> 'po_number' = 'PO-000001' and rls_test.get('po1') ->> 'status' = 'DRAFT'
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).company_id = rls_test.id('company_a'), rls_test.get('po1')::text);
select rls_test.ok('create: supplier, buyer and delivery snapshots; payment terms inherited; intra-state treatment',
  (rls_test.po(rls_test.gid('po1', 'po_id'))).supplier_name = 'Pune Ceramics Pvt Ltd' and (rls_test.po(rls_test.gid('po1', 'po_id'))).supplier_gstin = '27AAPFU0939F1ZV'
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).buyer_gstin = '27AAACA1234A1Z5' and (rls_test.po(rls_test.gid('po1', 'po_id'))).place_of_supply_state_code = '27'
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).delivery_address = 'Gate 2, MIDC Bhosari' and (rls_test.po(rls_test.gid('po1', 'po_id'))).payment_terms = 'DAYS_30'
  and not (rls_test.po(rls_test.gid('po1', 'po_id'))).payment_terms_overridden and (rls_test.po(rls_test.gid('po1', 'po_id'))).tax_treatment = 'INTRA_STATE');
select rls_test.ok('calc: basin 10 x 1000 less 10% = 9000 taxable, CGST 810 + SGST 810, total 10620; product snapshot (SKU, HSN, GST, unit, cost)',
  (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).taxable_value = 9000 and (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).cgst_amount = 810
  and (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).sgst_amount = 810 and (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).igst_amount = 0
  and (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).line_total = 10620 and (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).sku = 'PO-BASIN'
  and (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).hsn_sac = '6910' and (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).gst_rate = 18
  and (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).unit = 'PCS' and (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).master_cost_snapshot = 950);
select rls_test.ok('calc: clay 2.5 x 333.3333 = 833.33 less 10.50 = 822.83, CGST/SGST 2.5% = 20.57 each, total 863.97',
  (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).gross_amount = 833.33 and (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).taxable_value = 822.83
  and (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).cgst_amount = 20.57 and (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).line_total = 863.97,
  to_jsonb(rls_test.line(rls_test.gid('po1', 'po_id'), 2))::text);
select rls_test.ok('calc: totals gross 11333.33, discount 1010.50, taxable 10322.83, other charges 500, CGST = SGST 875.57, IGST 0, grand 12073.97',
  (rls_test.po(rls_test.gid('po1', 'po_id'))).gross_total = 11333.33 and (rls_test.po(rls_test.gid('po1', 'po_id'))).discount_total = 1010.50
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).taxable_total = 10322.83 and (rls_test.po(rls_test.gid('po1', 'po_id'))).other_charges_total = 500
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).cgst_total = 875.57 and (rls_test.po(rls_test.gid('po1', 'po_id'))).sgst_total = 875.57
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).igst_total = 0 and (rls_test.po(rls_test.gid('po1', 'po_id'))).grand_total = 12073.97,
  to_jsonb(rls_test.po(rls_test.gid('po1', 'po_id')))::text);
select rls_test.expect_call_ok('retry: the same create request (double click) returns the first result', 'po1_retry',
  rls_test.save(null, rls_test.get('hdr1'), rls_test.get('lines1'), 'e7e57600-0000-4000-8000-00000000aa01'));
select rls_test.ok('retry: no duplicate PO was created', rls_test.get('po1_retry') ->> 'po_id' = rls_test.get('po1') ->> 'po_id'
  and (rls_test.get('po1_retry') ->> 'duplicate')::boolean
  and (select count(*) from public.purchase_orders where company_id = rls_test.id('company_a')) = 1);
select rls_test.expect_call_error('create: a request id is required for new orders',
  rls_test.save(null, rls_test.get('hdr1'), rls_test.get('lines1'), null), 'request id');

-- Inter-state, round-off and numbering
reset role;
insert into public.company_settings (company_id, setting_key, setting_value) values (rls_test.id('company_a'), 'purchases.round_off_enabled', 'true'::jsonb);
set local role authenticated;
select rls_test.claims('pm');
select rls_test.expect_call_ok('create: inter-state supplier, GST rate overridden to 12%', 'po2',
  rls_test.save(null, jsonb_build_object('supplier_id', rls_test.id('s_inter'), 'purchase_type', 'FINISHED_GOODS', 'warehouse_id', rls_test.id('w1')),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('basin'), 'quantity', 3, 'unit_price', 999.99, 'gst_rate', 12)),
    'e7e57600-0000-4000-8000-00000000aa02'));
select rls_test.ok('calc: inter-state 3 x 999.99 = 2999.97, IGST 12% = 360.00, no CGST/SGST; total 3359.97 rounded to 3360.00 (+0.03); numbered PO-000002; terms from supplier (45 days)',
  rls_test.get('po2') ->> 'po_number' = 'PO-000002' and (rls_test.po(rls_test.gid('po2', 'po_id'))).tax_treatment = 'INTER_STATE'
  and (rls_test.po(rls_test.gid('po2', 'po_id'))).igst_total = 360 and (rls_test.po(rls_test.gid('po2', 'po_id'))).cgst_total = 0
  and (rls_test.po(rls_test.gid('po2', 'po_id'))).round_off = 0.03 and (rls_test.po(rls_test.gid('po2', 'po_id'))).grand_total = 3360
  and (rls_test.po(rls_test.gid('po2', 'po_id'))).payment_terms = 'DAYS_45', to_jsonb(rls_test.po(rls_test.gid('po2', 'po_id')))::text);
reset role;
delete from public.company_settings where company_id = rls_test.id('company_a') and setting_key = 'purchases.round_off_enabled';
set local role authenticated;
select rls_test.claims('pm');
select rls_test.expect_call_ok('create: unregistered supplier, unit price not yet known, payment terms overridden', 'po3',
  rls_test.save(null, jsonb_build_object('supplier_id', rls_test.id('s_unreg'), 'purchase_type', 'SERVICES', 'payment_terms', 'CUSTOM', 'custom_payment_days', 10),
    jsonb_build_array(jsonb_build_object('line_type', 'SERVICE', 'description', 'Kiln repair', 'unit', 'JOB', 'quantity', 1, 'gst_rate', 18)),
    'e7e57600-0000-4000-8000-00000000aa03'));
select rls_test.ok('calc: unregistered supplier -> no GST charged even with a rate; override recorded; PO-000003',
  rls_test.get('po3') ->> 'po_number' = 'PO-000003' and (rls_test.po(rls_test.gid('po3', 'po_id'))).tax_treatment = 'NO_GST'
  and (rls_test.po(rls_test.gid('po3', 'po_id'))).cgst_total = 0 and (rls_test.po(rls_test.gid('po3', 'po_id'))).igst_total = 0
  and (rls_test.po(rls_test.gid('po3', 'po_id'))).payment_terms_overridden and (rls_test.po(rls_test.gid('po3', 'po_id'))).custom_payment_days = 10);
select rls_test.expect_call_ok('create: 0.25% GST on a batch-tracked raw material', 'po4',
  rls_test.save(null, jsonb_build_object('supplier_id', rls_test.id('s_intra'), 'purchase_type', 'RAW_MATERIAL', 'warehouse_id', rls_test.id('w1')),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('clay'), 'quantity', 1, 'unit_price', 1000, 'gst_rate', 0.25)),
    'e7e57600-0000-4000-8000-00000000aa04'));
select rls_test.ok('calc: 0.25% intra-state -> CGST 0.125% + SGST 0.125% = 1.25 each, total 1002.50',
  (rls_test.line(rls_test.gid('po4', 'po_id'), 1)).cgst_rate = 0.125 and (rls_test.line(rls_test.gid('po4', 'po_id'), 1)).cgst_amount = 1.25
  and (rls_test.po(rls_test.gid('po4', 'po_id'))).grand_total = 1002.50);

-- Validation
select rls_test.expect_call_error('validation: quantity must be greater than zero',
  rls_test.save(null, rls_test.get('hdr1'), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('basin'), 'quantity', 0, 'unit_price', 1)), gen_random_uuid()), 'quantity');
select rls_test.expect_call_error('validation: negative unit price rejected',
  rls_test.save(null, rls_test.get('hdr1'), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('basin'), 'quantity', 1, 'unit_price', -5)), gen_random_uuid()), 'unit price');
select rls_test.expect_call_error('validation: quantity with more than 3 decimals rejected',
  rls_test.save(null, rls_test.get('hdr1'), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('basin'), 'quantity', 1.0001, 'unit_price', 1)), gen_random_uuid()), '3 decimal');
select rls_test.expect_call_error('validation: discount percentage and amount together rejected',
  rls_test.save(null, rls_test.get('hdr1'), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('basin'), 'quantity', 1, 'unit_price', 100, 'discount_percent', 5, 'discount_amount', 1)), gen_random_uuid()), 'not both');
select rls_test.expect_call_error('validation: discount larger than the line amount rejected',
  rls_test.save(null, rls_test.get('hdr1'), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('basin'), 'quantity', 1, 'unit_price', 100, 'discount_amount', 101)), gen_random_uuid()), 'exceed');
select rls_test.expect_call_error('validation: GST rate above 100 rejected',
  rls_test.save(null, rls_test.get('hdr1'), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('basin'), 'quantity', 1, 'unit_price', 100, 'gst_rate', 101)), gen_random_uuid()), 'GST rate');
select rls_test.expect_call_error('validation: an inactive supplier cannot be selected',
  rls_test.save(null, jsonb_build_object('supplier_id', rls_test.id('s_inactive'), 'purchase_type', 'OTHER'), rls_test.get('lines1'), gen_random_uuid()), 'inactive');
select rls_test.expect_call_error('validation: another company''s supplier cannot be selected',
  rls_test.save(null, jsonb_build_object('supplier_id', rls_test.id('b_sup'), 'purchase_type', 'OTHER'), rls_test.get('lines1'), gen_random_uuid()), 'valid supplier');
select rls_test.expect_call_error('validation: another company''s product cannot be ordered',
  rls_test.save(null, rls_test.get('hdr1'), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('b_prod'), 'quantity', 1, 'unit_price', 1)), gen_random_uuid()), 'not found');
select rls_test.expect_call_error('validation: an inactive product cannot be ordered',
  rls_test.save(null, rls_test.get('hdr1'), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('old'), 'quantity', 1, 'unit_price', 1)), gen_random_uuid()), 'inactive');
select rls_test.expect_call_error('validation: goods lines need a product',
  rls_test.save(null, rls_test.get('hdr1'), jsonb_build_array(jsonb_build_object('line_type', 'GOODS', 'description', 'Free text', 'quantity', 1, 'unit_price', 1)), gen_random_uuid()), 'product');
select rls_test.expect_call_error('validation: expected delivery before the PO date rejected',
  rls_test.save(null, rls_test.get('hdr1') || jsonb_build_object('expected_delivery_date', (current_date - 30)::text), rls_test.get('lines1'), gen_random_uuid()), 'expected delivery');
select rls_test.expect_call_error('validation: future PO date rejected',
  rls_test.save(null, rls_test.get('hdr1') || jsonb_build_object('po_date', (current_date + 10)::text), rls_test.get('lines1'), gen_random_uuid()), 'future');
select rls_test.expect_call_error('validation: an order needs lines', rls_test.save(null, rls_test.get('hdr1'), '[]'::jsonb, gen_random_uuid()), 'at least one line');
select rls_test.ok('validation: rejected requests created nothing (still 4 POs)', (select count(*) from public.purchase_orders where company_id = rls_test.id('company_a')) = 4);

-- Edit drafts
select rls_test.set('lines1b', jsonb_set(rls_test.get('lines1'), '{0,quantity}', '12'::jsonb));
select rls_test.expect_call_error('edit: a stale version is refused (concurrent edit)',
  format('select public.purchase_order_save(%L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('po1', 'po_id'), rls_test.get('hdr1'), rls_test.get('lines1b'), '2000-01-01T00:00:00Z'), 'changed by someone else');
select rls_test.expect_call_ok('edit: the creator edits the draft (basin 10 -> 12)', 'po1_edit', rls_test.save(rls_test.gid('po1', 'po_id'), rls_test.get('hdr1'), rls_test.get('lines1b')));
select rls_test.ok('edit: totals recalculated (basin 12 -> taxable 10800, grand 14197.97); still PO-000001',
  (rls_test.po(rls_test.gid('po1', 'po_id'))).grand_total = 14197.97 and (rls_test.po(rls_test.gid('po1', 'po_id'))).cgst_total = 1037.57
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).po_number = 'PO-000001');
select rls_test.claims('inv');
select rls_test.expect_call_error('edit: Inventory Manager cannot create or edit POs',
  rls_test.save(rls_test.gid('po1', 'po_id'), rls_test.get('hdr1'), rls_test.get('lines1b')), 'purchase_order', '42501');
select rls_test.claims('acct');
select rls_test.expect_call_error('edit: Accounts Manager cannot edit POs',
  rls_test.save(rls_test.gid('po1', 'po_id'), rls_test.get('hdr1'), rls_test.get('lines1b')), 'purchase_order', '42501');

-- ---------------------------------------------------------------------------
-- Submission, approval, rejection, segregation of duties
-- ---------------------------------------------------------------------------
select rls_test.claims('pm');
select rls_test.expect_call_error('submit: a line without a price blocks submission', rls_test.act(rls_test.gid('po3', 'po_id'), 'SUBMIT'), 'unit price');
select rls_test.expect_call_ok('submit: draft submitted for approval', 'po1_sub', rls_test.act(rls_test.gid('po1', 'po_id'), 'SUBMIT'));
select rls_test.ok('submit: PENDING_APPROVAL with requester and time',
  (rls_test.po(rls_test.gid('po1', 'po_id'))).status = 'PENDING_APPROVAL' and (rls_test.po(rls_test.gid('po1', 'po_id'))).submitted_by = rls_test.id('pm')
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).submitted_at is not null);
select rls_test.expect_call_error('submit: an order awaiting approval cannot be edited',
  rls_test.save(rls_test.gid('po1', 'po_id'), rls_test.get('hdr1'), rls_test.get('lines1b')), 'Only draft');
select rls_test.expect_call_error('approve: segregation of duties - the creator cannot approve their own order',
  rls_test.act(rls_test.gid('po1', 'po_id'), 'APPROVE'), 'Segregation of duties', '42501');
select rls_test.claims('acct');
select rls_test.expect_call_error('approve: Accounts Manager has no approval permission', rls_test.act(rls_test.gid('po1', 'po_id'), 'APPROVE'), 'purchase_order.approve', '42501');
select rls_test.claims('pm2');
select rls_test.expect_call_error('reject: a reason is required', rls_test.act(rls_test.gid('po1', 'po_id'), 'REJECT', ''), 'reason');
select rls_test.expect_call_ok('reject: another Purchase Manager rejects with a reason', 'po1_rej', rls_test.act(rls_test.gid('po1', 'po_id'), 'REJECT', 'Check clay price'));
select rls_test.ok('reject: back to DRAFT with the reason and rejector recorded',
  (rls_test.po(rls_test.gid('po1', 'po_id'))).status = 'DRAFT' and (rls_test.po(rls_test.gid('po1', 'po_id'))).rejection_reason = 'Check clay price'
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).rejected_by = rls_test.id('pm2'));
select rls_test.claims('pm');
select rls_test.expect_call_ok('submit: resubmitted after rejection', 'po1_sub2', rls_test.act(rls_test.gid('po1', 'po_id'), 'SUBMIT'));
select rls_test.expect_call_error('receipt: goods cannot be received before approval',
  rls_test.receive(rls_test.gid('po1', 'po_id'), jsonb_build_array(jsonb_build_object('po_line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).id, 'received_quantity', 1, 'accepted_quantity', 1, 'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()),
  'approved order');
select rls_test.claims('pm2');
select rls_test.ok('approval inbox: the pending PO is listed for an approver',
  exists (select 1 from jsonb_array_elements(public.approval_inbox('TO_DECIDE', 100) -> 'module_items') m
          where m ->> 'document_type' = 'PURCHASE_ORDER' and m ->> 'reference' = 'PO-000001' and m ->> 'link' = '/purchase-orders/' || rls_test.gid('po1', 'po_id')));
select rls_test.expect_call_ok('approve: a different authorised user approves', 'po1_app', rls_test.act(rls_test.gid('po1', 'po_id'), 'APPROVE'));
select rls_test.ok('approve: APPROVED with approver and time; rejection cleared',
  (rls_test.po(rls_test.gid('po1', 'po_id'))).status = 'APPROVED' and (rls_test.po(rls_test.gid('po1', 'po_id'))).approved_by = rls_test.id('pm2')
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).rejection_reason is null);
select rls_test.expect_call_error('approve: an approved order cannot be edited directly',
  rls_test.save(rls_test.gid('po1', 'po_id'), rls_test.get('hdr1'), rls_test.get('lines1b')), 'Amend');

-- Missing company GSTIN (company B)
select rls_test.claims('b_pm');
select rls_test.expect_call_ok('company B: draft with a registered supplier', 'pob',
  rls_test.save(null, jsonb_build_object('supplier_id', rls_test.id('b_sup'), 'purchase_type', 'FINISHED_GOODS', 'warehouse_id', rls_test.id('wb')),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('b_prod'), 'quantity', 1, 'unit_price', 100)), 'e7e57600-0000-4000-8000-00000000bb01'));
select rls_test.ok('company B: numbering is per company (PO-000001); tax UNRESOLVED without a company GSTIN, no tax invented',
  rls_test.get('pob') ->> 'po_number' = 'PO-000001' and (rls_test.po(rls_test.gid('pob', 'po_id'))).tax_treatment = 'UNRESOLVED'
  and (rls_test.po(rls_test.gid('pob', 'po_id'))).cgst_total = 0 and (rls_test.po(rls_test.gid('pob', 'po_id'))).igst_total = 0);
select rls_test.expect_call_error('company B: submission blocked until the company GSTIN is set', rls_test.act(rls_test.gid('pob', 'po_id'), 'SUBMIT'), 'company GSTIN');
select rls_test.expect_rows('isolation: company B sees none of company A''s orders', format($q$ select 1 from public.purchase_orders where company_id = %L $q$, rls_test.id('company_a')), 0);
select rls_test.expect_rows('isolation: company B sees none of company A''s lines or events',
  format($q$ select 1 from public.purchase_order_lines where purchase_order_id = %L union all select 1 from public.purchase_order_events where purchase_order_id = %L $q$,
    rls_test.gid('po1', 'po_id'), rls_test.gid('po1', 'po_id')), 0);
select rls_test.expect_call_error('isolation: company B cannot act on company A''s order', rls_test.act(rls_test.gid('po1', 'po_id'), 'CANCEL', 'hostile cancel'), 'not found');
select rls_test.expect_call_error('isolation: company B cannot receive on company A''s order',
  rls_test.receive(rls_test.gid('po1', 'po_id'), jsonb_build_array(jsonb_build_object('po_line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).id, 'received_quantity', 1, 'accepted_quantity', 1)), gen_random_uuid()), 'not found');
select rls_test.expect_call_error('isolation: company B cannot edit company A''s order', rls_test.save(rls_test.gid('po1', 'po_id'), rls_test.get('hdr1'), rls_test.get('lines1b')), 'not found');

-- ---------------------------------------------------------------------------
-- Goods receipts
-- ---------------------------------------------------------------------------
select rls_test.claims('acct');
select rls_test.expect_call_error('receipt: Accounts Manager cannot record receipts',
  rls_test.receive(rls_test.gid('po1', 'po_id'), '[]'::jsonb, gen_random_uuid()), 'purchase_receipt.create', '42501');
select rls_test.claims('inv');
select rls_test.set('r1_lines', jsonb_build_array(
  jsonb_build_object('po_line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).id, 'received_quantity', 4, 'accepted_quantity', 4, 'rejected_quantity', 0, 'accepted_location_id', rls_test.id('g1')),
  jsonb_build_object('po_line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).id, 'received_quantity', 1.5, 'accepted_quantity', 1, 'rejected_quantity', 0.5,
    'accepted_location_id', rls_test.id('g1'), 'rejected_location_id', rls_test.id('rej'), 'rejection_reason', 'Damaged bags', 'batch_number', 'CL-1')));
select rls_test.expect_call_error('receipt: accepted + rejected must equal received',
  rls_test.receive(rls_test.gid('po1', 'po_id'), jsonb_build_array(jsonb_build_object('po_line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).id, 'received_quantity', 4, 'accepted_quantity', 3, 'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()), 'must equal');
select rls_test.expect_call_error('receipt: rejected goods need a reason',
  rls_test.receive(rls_test.gid('po1', 'po_id'), jsonb_build_array(jsonb_build_object('po_line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).id, 'received_quantity', 1, 'accepted_quantity', 0, 'rejected_quantity', 1)), gen_random_uuid()), 'reason');
select rls_test.expect_call_error('receipt: rejected goods cannot go to a storage (available) location',
  rls_test.receive(rls_test.gid('po1', 'po_id'), jsonb_build_array(jsonb_build_object('po_line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).id, 'received_quantity', 1, 'accepted_quantity', 0, 'rejected_quantity', 1, 'rejection_reason', 'cracked', 'rejected_location_id', rls_test.id('g1'))), gen_random_uuid()), 'quarantine');
select rls_test.expect_call_error('receipt: accepted goods must go to the order''s warehouse',
  rls_test.receive(rls_test.gid('po1', 'po_id'), jsonb_build_array(jsonb_build_object('po_line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).id, 'received_quantity', 1, 'accepted_quantity', 1, 'accepted_location_id', rls_test.id('g2'))), gen_random_uuid()), 'warehouse W1');
select rls_test.expect_call_error('receipt: charges are not received',
  rls_test.receive(rls_test.gid('po1', 'po_id'), jsonb_build_array(jsonb_build_object('po_line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 3)).id, 'received_quantity', 1, 'accepted_quantity', 1)), gen_random_uuid()), 'charge');
select rls_test.expect_call_error('receipt: the receipt date cannot be in the future',
  rls_test.receive(rls_test.gid('po1', 'po_id'), rls_test.get('r1_lines'), gen_random_uuid(), jsonb_build_object('receipt_date', (current_date + 2)::text)), 'future');
select rls_test.expect_call_error('atomic: a failing second line (batch number missing) posts nothing',
  rls_test.receive(rls_test.gid('po1', 'po_id'), jsonb_build_array(rls_test.get('r1_lines') -> 0, (rls_test.get('r1_lines') -> 1) - 'batch_number'), gen_random_uuid()), 'batch');
select rls_test.ok('atomic: no receipt, ledger entry or stock remains from the failed request',
  rls_test.count_receipts(rls_test.gid('po1', 'po_id')) = 0 and rls_test.count_tx(rls_test.gid('po1', 'po_id')) = 0
  and rls_test.on_hand(rls_test.id('basin'), rls_test.id('g1')) = 0);
select rls_test.expect_call_ok('receipt: Inventory Manager posts a partial receipt with rejected goods', 'r1',
  rls_test.receive(rls_test.gid('po1', 'po_id'), rls_test.get('r1_lines'), 'e7e57600-0000-4000-8000-00000000cc01',
    jsonb_build_object('supplier_document_number', 'DC-554', 'supporting_document_ref', 'Invoice 8812')));
select rls_test.ok('receipt: GRN-000001; PO PARTIALLY_RECEIVED; 3 ledger postings (basin, clay accepted, clay rejected)',
  rls_test.get('r1') ->> 'receipt_number' = 'GRN-000001' and (rls_test.po(rls_test.gid('po1', 'po_id'))).status = 'PARTIALLY_RECEIVED'
  and rls_test.count_tx(rls_test.gid('po1', 'po_id')) = 3, rls_test.get('r1')::text);
select rls_test.ok('inventory: basin +4 in storage; clay lot CL-1 +1 in storage and +0.5 in the rejected bay (not available stock)',
  rls_test.on_hand(rls_test.id('basin'), rls_test.id('g1')) = 4 and rls_test.on_hand(rls_test.id('clay'), rls_test.id('g1')) = 1
  and rls_test.on_hand(rls_test.id('clay'), rls_test.id('rej')) = 0.5
  and (select stock_usage from public.inventory_locations where id = rls_test.id('rej')) = 'REJECTED');
select rls_test.ok('inventory: ledger rows are RECEIPTs of document PURCHASE_ORDER at the line cost excl. GST (basin 900, clay 329.1320), lot source OUTSOURCED',
  (select bool_and(transaction_type = 'RECEIPT' and document_type = 'PURCHASE_ORDER' and reference_number = 'PO-000001')
     from public.inventory_transactions where reference_id = rls_test.gid('po1', 'po_id'))
  and (select unit_cost from public.inventory_transactions where reference_id = rls_test.gid('po1', 'po_id') and product_id = rls_test.id('basin')) = 900
  and (select max(unit_cost) from public.inventory_transactions where reference_id = rls_test.gid('po1', 'po_id') and product_id = rls_test.id('clay')) = 329.1320
  and (select bool_and(b.source_type = 'OUTSOURCED') from public.inventory_transactions t join public.inventory_batches b on b.id = t.batch_id
       where t.reference_id = rls_test.gid('po1', 'po_id')));
select rls_test.expect_call_ok('retry: re-sending the same receipt request returns the first result', 'r1_retry',
  rls_test.receive(rls_test.gid('po1', 'po_id'), rls_test.get('r1_lines'), 'e7e57600-0000-4000-8000-00000000cc01'));
select rls_test.ok('retry: no duplicate receipt or stock posting',
  rls_test.get('r1_retry') ->> 'receipt_number' = 'GRN-000001' and (rls_test.get('r1_retry') ->> 'duplicate')::boolean
  and rls_test.count_receipts(rls_test.gid('po1', 'po_id')) = 1 and rls_test.count_tx(rls_test.gid('po1', 'po_id')) = 3
  and rls_test.on_hand(rls_test.id('basin'), rls_test.id('g1')) = 4);
select rls_test.ok('received quantities come from receipt lines: basin 4 accepted / 8 pending; clay 1.5 received, 1 accepted, 0.5 rejected, 1.5 pending',
  exists (select 1 from public.purchase_order_line_list where id = (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).id and accepted_quantity = 4 and pending_quantity = 8)
  and exists (select 1 from public.purchase_order_line_list where id = (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).id
              and received_quantity = 1.5 and accepted_quantity = 1 and rejected_quantity = 0.5 and pending_quantity = 1.5));
select rls_test.expect_call_error('over-receipt: receiving more than pending (9 > 8) needs purchase_exception.approve',
  rls_test.receive(rls_test.gid('po1', 'po_id'), jsonb_build_array(jsonb_build_object('po_line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).id, 'received_quantity', 9, 'accepted_quantity', 9, 'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()),
  'purchase_exception.approve', '42501');
select rls_test.claims('sa');
select rls_test.expect_call_error('over-receipt: even an authorised user must document the reason',
  rls_test.receive(rls_test.gid('po1', 'po_id'), jsonb_build_array(jsonb_build_object('po_line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).id, 'received_quantity', 9, 'accepted_quantity', 9, 'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()),
  'documented reason');

-- ---------------------------------------------------------------------------
-- Amendment of a partially received order
-- ---------------------------------------------------------------------------
select rls_test.claims('inv');
select rls_test.expect_call_error('amend: requires purchase_order.amend', rls_test.act(rls_test.gid('po1', 'po_id'), 'AMEND', 'Price change'), 'purchase_order.amend', '42501');
select rls_test.claims('pm');
select rls_test.expect_call_error('amend: a reason is required', rls_test.act(rls_test.gid('po1', 'po_id'), 'AMEND', 'x'), 'reason');
select rls_test.expect_call_ok('amend: Purchase Manager opens revision 1', 'po1_amend', rls_test.act(rls_test.gid('po1', 'po_id'), 'AMEND', 'Supplier revised the clay price'));
select rls_test.ok('amend: DRAFT, revision 1, approval cleared; previous version kept in purchase_order_amendments',
  (rls_test.po(rls_test.gid('po1', 'po_id'))).status = 'DRAFT' and (rls_test.po(rls_test.gid('po1', 'po_id'))).revision = 1
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).approved_by is null
  and exists (select 1 from public.purchase_order_amendments where purchase_order_id = rls_test.gid('po1', 'po_id') and from_revision = 0 and to_revision = 1
              and (previous_version ->> 'grand_total')::numeric = 14197.97 and jsonb_array_length(previous_version -> 'lines') = 3));
select rls_test.set('lines_amend', jsonb_build_array(
  jsonb_build_object('id', (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).id, 'product_id', rls_test.id('basin'), 'quantity', 12, 'unit_price', 1000, 'discount_percent', 10),
  jsonb_build_object('id', (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).id, 'product_id', rls_test.id('clay'), 'quantity', 2.5, 'unit_price', 340, 'discount_amount', 10.5),
  jsonb_build_object('id', (rls_test.line(rls_test.gid('po1', 'po_id'), 3)).id, 'line_type', 'CHARGE', 'description', 'Freight', 'unit', 'NOS', 'quantity', 1, 'unit_price', 500, 'gst_rate', 18)));
select rls_test.expect_call_error('amend: quantity cannot go below what was received',
  rls_test.save(rls_test.gid('po1', 'po_id'), rls_test.get('hdr1'), jsonb_set(rls_test.get('lines_amend'), '{0,quantity}', '3'::jsonb)), 'already received');
select rls_test.expect_call_error('amend: a line with received goods cannot be removed',
  rls_test.save(rls_test.gid('po1', 'po_id'), rls_test.get('hdr1'), rls_test.get('lines_amend') - 1), 'cannot be removed');
select rls_test.expect_call_error('amend: the supplier cannot be changed',
  rls_test.save(rls_test.gid('po1', 'po_id'), rls_test.get('hdr1') || jsonb_build_object('supplier_id', rls_test.id('s_inter')), rls_test.get('lines_amend')), 'supplier');
select rls_test.expect_call_ok('amend: new clay price saved', 'po1_amended', rls_test.save(rls_test.gid('po1', 'po_id'), rls_test.get('hdr1'), rls_test.get('lines_amend')));
select rls_test.ok('amend: clay 2.5 x 340 = 850 less 10.50 = 839.50, CGST/SGST 20.99 each; grand 14215.48',
  (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).cgst_amount = 20.99 and (rls_test.po(rls_test.gid('po1', 'po_id'))).grand_total = 14215.48);
select rls_test.expect_call_ok('amend: resubmitted', 'po1_sub3', rls_test.act(rls_test.gid('po1', 'po_id'), 'SUBMIT'));
select rls_test.claims('pm2');
select rls_test.expect_call_ok('amend: re-approved by another user', 'po1_app2', rls_test.act(rls_test.gid('po1', 'po_id'), 'APPROVE'));
select rls_test.ok('amend: re-approval keeps the receipt state (PARTIALLY_RECEIVED)', (rls_test.po(rls_test.gid('po1', 'po_id'))).status = 'PARTIALLY_RECEIVED');

select rls_test.claims('inv');
select rls_test.expect_call_ok('receipt: second delivery receives the rest', 'r2',
  rls_test.receive(rls_test.gid('po1', 'po_id'), jsonb_build_array(
    jsonb_build_object('po_line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).id, 'received_quantity', 8, 'accepted_quantity', 8, 'accepted_location_id', rls_test.id('g1')),
    jsonb_build_object('po_line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).id, 'received_quantity', 1.5, 'accepted_quantity', 1.5, 'accepted_location_id', rls_test.id('g1'), 'batch_number', 'CL-1')),
    'e7e57600-0000-4000-8000-00000000cc02'));
select rls_test.ok('receipt: GRN-000002; all lines received -> RECEIVED; basin 12 in stock',
  rls_test.get('r2') ->> 'receipt_number' = 'GRN-000002' and (rls_test.po(rls_test.gid('po1', 'po_id'))).status = 'RECEIVED'
  and rls_test.on_hand(rls_test.id('basin'), rls_test.id('g1')) = 12, rls_test.get('r2')::text);
select rls_test.ok('reconciliation: net ledger quantity for the PO equals the posted receipt quantities (4 + 1 + 0.5 + 8 + 1.5 = 15)',
  rls_test.po_ledger_net(rls_test.gid('po1', 'po_id')) = rls_test.po_posted_qty(rls_test.gid('po1', 'po_id'))
  and rls_test.po_ledger_net(rls_test.gid('po1', 'po_id')) = 15,
  format('ledger=%s receipts=%s', rls_test.po_ledger_net(rls_test.gid('po1', 'po_id')), rls_test.po_posted_qty(rls_test.gid('po1', 'po_id'))));
select rls_test.expect_call_error('receipt: nothing more can be received on a fully received order without an exception',
  rls_test.receive(rls_test.gid('po1', 'po_id'), jsonb_build_array(jsonb_build_object('po_line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 1)).id, 'received_quantity', 1, 'accepted_quantity', 1, 'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()),
  'Goods can only be received');

-- Cancellation restrictions and reversal
select rls_test.claims('pm');
select rls_test.expect_call_error('cancel: an order with receipts cannot be cancelled', rls_test.act(rls_test.gid('po1', 'po_id'), 'CANCEL', 'No longer needed'), 'cannot be cancelled');
select rls_test.claims('inv');
select rls_test.expect_call_error('reversal: stock postings of a PO cannot be reversed from the generic ledger',
  format('select public.inventory_reverse_transaction(%L, %L, %L)',
    (select t.id from public.inventory_transactions t where t.reference_id = rls_test.gid('po1', 'po_id') limit 1), 'mistake', gen_random_uuid()), 'goods receipt');
select rls_test.expect_call_error('reversal: requires purchase_exception.approve',
  format('select public.purchase_receipt_reverse(%L, %L, %L)', rls_test.gid('r2', 'receipt_id'), 'Wrong quantity', gen_random_uuid()), 'purchase_exception.approve', '42501');
select rls_test.claims('adm');
select rls_test.expect_call_ok('reversal: Administrator reverses the second receipt', 'r2_rev',
  format('select public.purchase_receipt_reverse(%L, %L, %L)', rls_test.gid('r2', 'receipt_id'), 'Counted twice at the gate', 'e7e57600-0000-4000-8000-00000000dd01'));
select rls_test.ok('reversal: receipt REVERSED, PO back to PARTIALLY_RECEIVED, basin stock back to 4, ledger still reconciles (5.5)',
  (select status from public.goods_receipts where id = rls_test.gid('r2', 'receipt_id')) = 'REVERSED'
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).status = 'PARTIALLY_RECEIVED'
  and rls_test.on_hand(rls_test.id('basin'), rls_test.id('g1')) = 4
  and rls_test.po_ledger_net(rls_test.gid('po1', 'po_id')) = rls_test.po_posted_qty(rls_test.gid('po1', 'po_id'))
  and rls_test.po_ledger_net(rls_test.gid('po1', 'po_id')) = 5.5);
select rls_test.expect_call_error('reversal: a receipt cannot be reversed twice',
  format('select public.purchase_receipt_reverse(%L, %L, %L)', rls_test.gid('r2', 'receipt_id'), 'again please', gen_random_uuid()), 'already been reversed');

-- PO4: send, partial receipt, short-close
select rls_test.claims('pm');
select rls_test.expect_call_ok('workflow: PO4 submitted', 'po4_sub', rls_test.act(rls_test.gid('po4', 'po_id'), 'SUBMIT'));
select rls_test.claims('pm2');
select rls_test.expect_call_error('send: an order awaiting approval cannot be sent', rls_test.act(rls_test.gid('po4', 'po_id'), 'SEND'), 'approved');
select rls_test.expect_call_ok('workflow: PO4 approved', 'po4_app', rls_test.act(rls_test.gid('po4', 'po_id'), 'APPROVE'));
select rls_test.expect_call_ok('send: marked as sent to the supplier', 'po4_send', rls_test.act(rls_test.gid('po4', 'po_id'), 'SEND', 'E-mailed to supplier'));
select rls_test.ok('send: SENT with sender and time', (rls_test.po(rls_test.gid('po4', 'po_id'))).status = 'SENT' and (rls_test.po(rls_test.gid('po4', 'po_id'))).sent_by = rls_test.id('pm2'));
select rls_test.claims('inv');
select rls_test.expect_call_ok('receipt: part of PO4 received', 'r3',
  rls_test.receive(rls_test.gid('po4', 'po_id'), jsonb_build_array(jsonb_build_object('po_line_id', (rls_test.line(rls_test.gid('po4', 'po_id'), 1)).id,
    'received_quantity', 0.4, 'accepted_quantity', 0.4, 'accepted_location_id', rls_test.id('g1'), 'batch_number', 'CL-2')), 'e7e57600-0000-4000-8000-00000000cc03'));
select rls_test.claims('acct');
select rls_test.expect_call_error('close: requires purchase_order.cancel', rls_test.act(rls_test.gid('po4', 'po_id'), 'CLOSE', 'Supplier cannot supply more'), 'purchase_order.cancel', '42501');
select rls_test.claims('pm');
select rls_test.expect_call_error('close: a reason is required', rls_test.act(rls_test.gid('po4', 'po_id'), 'CLOSE', ''), 'reason');
select rls_test.expect_call_ok('close: partially received order short-closed', 'po4_close', rls_test.act(rls_test.gid('po4', 'po_id'), 'CLOSE', 'Supplier cannot supply more'));
select rls_test.ok('close: CLOSED with reason', (rls_test.po(rls_test.gid('po4', 'po_id'))).status = 'CLOSED'
  and (rls_test.po(rls_test.gid('po4', 'po_id'))).close_reason = 'Supplier cannot supply more');
select rls_test.claims('inv');
select rls_test.expect_call_error('close: nothing can be received on a closed order',
  rls_test.receive(rls_test.gid('po4', 'po_id'), jsonb_build_array(jsonb_build_object('po_line_id', (rls_test.line(rls_test.gid('po4', 'po_id'), 1)).id, 'received_quantity', 0.1, 'accepted_quantity', 0.1, 'accepted_location_id', rls_test.id('g1'), 'batch_number', 'CL-2')), gen_random_uuid()),
  'closed');

-- PO2 / PO3: cancel and withdraw
select rls_test.claims('pm');
select rls_test.expect_call_error('cancel: a reason is required', rls_test.act(rls_test.gid('po2', 'po_id'), 'CANCEL', 'no'), 'reason');
select rls_test.expect_call_ok('cancel: draft cancelled with a reason', 'po2_cancel', rls_test.act(rls_test.gid('po2', 'po_id'), 'CANCEL', 'Ordered from another supplier'));
select rls_test.expect_call_error('cancel: a cancelled order cannot be submitted', rls_test.act(rls_test.gid('po2', 'po_id'), 'SUBMIT'), 'draft');
select rls_test.expect_call_ok('withdraw: PO3 priced, submitted and withdrawn by the submitter', 'po3_save',
  rls_test.save(rls_test.gid('po3', 'po_id'), jsonb_build_object('supplier_id', rls_test.id('s_unreg'), 'purchase_type', 'SERVICES'),
    jsonb_build_array(jsonb_build_object('line_type', 'SERVICE', 'description', 'Kiln repair', 'unit', 'JOB', 'quantity', 1, 'unit_price', 4500))));
select rls_test.call(rls_test.act(rls_test.gid('po3', 'po_id'), 'SUBMIT'));
select rls_test.expect_call_ok('withdraw: back to draft', 'po3_wd', rls_test.act(rls_test.gid('po3', 'po_id'), 'WITHDRAW'));
select rls_test.ok('withdraw: PO3 is DRAFT again; terms reverted to the supplier''s', (rls_test.po(rls_test.gid('po3', 'po_id'))).status = 'DRAFT'
  and (rls_test.po(rls_test.gid('po3', 'po_id'))).payment_terms = 'IMMEDIATE' and not (rls_test.po(rls_test.gid('po3', 'po_id'))).payment_terms_overridden);

-- ---------------------------------------------------------------------------
-- Visibility, direct writes, helpers, audit and dashboard
-- ---------------------------------------------------------------------------
select rls_test.claims('sales');
select rls_test.expect_rows('visibility: a role without purchases.read sees no orders', 'select 1 from public.purchase_orders', 0);
select rls_test.claims('viewer');
select rls_test.expect_rows('visibility: Management Viewer (purchases.read) sees company A''s 4 orders', 'select 1 from public.purchase_order_list', 4);
select rls_test.expect_call_error('visibility: ... but cannot create orders', rls_test.save(null, rls_test.get('hdr1'), rls_test.get('lines1'), gen_random_uuid()), 'purchase_order', '42501');
select rls_test.claims('pm');
select rls_test.expect_error('direct write: totals cannot be changed with an UPDATE',
  format($q$ update public.purchase_orders set grand_total = 1 where id = %L $q$, rls_test.gid('po1', 'po_id')), '42501');
select rls_test.expect_error('direct write: receipts cannot be inserted directly',
  format($q$ insert into public.goods_receipts (company_id, receipt_number, purchase_order_id, po_revision, supplier_id, receipt_date) values (%L, 'GRN-999999', %L, 0, %L, current_date) $q$,
    rls_test.id('company_a'), rls_test.gid('po1', 'po_id'), rls_test.id('s_intra')), '42501');
select rls_test.ok('supplier options: only active suppliers of the company are offered',
  (select array_agg(supplier_code order by supplier_code) from public.purchase_supplier_options()) = array['S-INTER', 'S-INTRA', 'S-UNREG']);
select rls_test.claims('acct');
select rls_test.expect_error('supplier options: not available without purchase_order.create/update', 'select * from public.purchase_supplier_options()', '42501');
select rls_test.ok('dashboard: counts by status, approved value in period (14215.48 + 1002.50) and outstanding receipt value (8496.00 + 528.89)',
  (public.purchase_order_dashboard(current_date - 1, current_date) ->> 'total')::int = 4
  and (public.purchase_order_dashboard(current_date - 1, current_date) -> 'by_status' ->> 'PARTIALLY_RECEIVED')::int = 1
  and (public.purchase_order_dashboard(current_date - 1, current_date) -> 'by_status' ->> 'CANCELLED')::int = 1
  and (public.purchase_order_dashboard(current_date - 1, current_date) ->> 'period_value')::numeric = 15217.98
  and (public.purchase_order_dashboard(current_date - 1, current_date) ->> 'outstanding_receipt_value')::numeric = 9024.89,
  public.purchase_order_dashboard(current_date - 1, current_date)::text);
select rls_test.ok('history: events record create, submit, reject, approve, amend, receipts, reversal (with actors)',
  (select array_agg(distinct event_type order by event_type) from public.purchase_order_events where purchase_order_id = rls_test.gid('po1', 'po_id'))
    @> array['AMENDED', 'APPROVED', 'CREATED', 'RECEIPT_POSTED', 'RECEIPT_REVERSED', 'REJECTED', 'SUBMITTED', 'UPDATED']
  and not exists (select 1 from public.purchase_order_events where purchase_order_id = rls_test.gid('po1', 'po_id') and actor_user_id is null));

reset role;
select rls_test.ok('audit: events mirrored to audit_logs as purchasing.* on the purchase order',
  exists (select 1 from public.audit_logs where resource_type = 'purchase_order' and resource_id = rls_test.gid('po1', 'po_id')::text and action = 'purchasing.approved')
  and exists (select 1 from public.audit_logs where resource_type = 'purchase_order' and resource_id = rls_test.gid('po1', 'po_id')::text and action = 'purchasing.receipt_posted'
              and actor_user_id = rls_test.id('inv'))
  and exists (select 1 from public.audit_logs where resource_type = 'purchase_order' and action = 'purchasing.cancelled' and metadata ->> 'note' = 'Ordered from another supplier'));
select rls_test.expect_error('history: events are append-only', format($q$ delete from public.purchase_order_events where purchase_order_id = %L $q$, rls_test.gid('po1', 'po_id')));
select rls_test.expect_error('history: posted receipt lines cannot be changed', 'update public.goods_receipt_lines set accepted_quantity = 0');
select rls_test.ok('numbering: PO numbers are unique per company and sequential (A: PO-000001..4, B: PO-000001)',
  (select array_agg(po_number order by po_number) from public.purchase_orders where company_id = rls_test.id('company_a')) = array['PO-000001', 'PO-000002', 'PO-000003', 'PO-000004']
  and (select count(*) from public.purchase_orders where company_id = rls_test.id('company_b')) = 1);

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
  raise exception 'PURCHASE_ORDER_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
