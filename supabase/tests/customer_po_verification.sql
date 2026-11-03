-- =============================================================================
-- CUSTOMER PO (PHASE 6) VERIFICATION
--
-- Executable checks for PO import, duplicate / revision protection, product
-- matching, stock availability (reserved / non-saleable / expired / unknown
-- exclusion, in-house vs outsourced, multi-warehouse), allocation strategies,
-- over-allocation and competing allocations, idempotency, rollback, release,
-- dispatch, cancellation, shortages, snapshots, dashboard, RLS and
-- cross-company isolation.
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction with its own companies (POA / POB) and ALWAYS ends
-- by raising CUSTOMER_PO_VERIFICATION_RESULT passed=N failed=M so that all
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
create function rls_test.expect_error(p_name text, p_sql text) returns void language plpgsql as $$
begin execute p_sql; perform rls_test.ok(p_name, false, 'statement succeeded but should have been rejected');
exception when others then perform rls_test.ok(p_name, true, format('rejected %s: %s', sqlstate, sqlerrm)); end $$;
create function rls_test.expect_call_ok(p_name text, p_key text, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.set(p_key, r); perform rls_test.ok(p_name, not (r ? 'error'), r::text); return r; end $$;
create function rls_test.expect_call_error(p_name text, p_sql text, p_pattern text default null) returns void language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.ok(p_name, r ? 'error' and (p_pattern is null or r ->> 'error' ilike '%' || p_pattern || '%'), r::text); end $$;
create function rls_test.claims(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', rls_test.id(p_key), 'role', 'authenticated')::text, true) $$;

-- Owner-side probes
create function rls_test.on_hand(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(on_hand), 0) from public.inventory_balances where product_id = p_product $$;
create function rls_test.reserved(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(reserved), 0) from public.inventory_balances where product_id = p_product $$;
create function rls_test.line(p_po uuid, p_row int) returns public.customer_purchase_order_lines language sql stable security definer as $$
  select * from public.customer_purchase_order_lines where purchase_order_id = p_po and source_row_number = p_row $$;
create function rls_test.po(p_po uuid) returns public.customer_purchase_orders language sql stable security definer as $$
  select * from public.customer_purchase_orders where id = p_po $$;
create function rls_test.po_reserved(p_po uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(r.quantity - r.fulfilled_quantity - r.released_quantity), 0) from public.stock_reservations r
  join public.customer_purchase_order_lines l on l.id = r.reference_id
  where l.purchase_order_id = p_po and r.reference_type = 'CUSTOMER_PO' and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') $$;
create function rls_test.balance(p_product uuid, p_location uuid, p_source text) returns uuid language sql stable security definer as $$
  select id from public.inventory_balances where product_id = p_product and location_id = p_location and source_type = p_source limit 1 $$;
create function rls_test.lot_balance(p_product uuid, p_batch text) returns uuid language sql stable security definer as $$
  select b.id from public.inventory_balances b join public.inventory_batches bt on bt.id = b.batch_id
  where b.product_id = p_product and bt.batch_number = p_batch limit 1 $$;
create function rls_test.aline(p_po uuid, p_row int) returns jsonb language sql stable security definer as $$
  select to_jsonb(a) from private.po_line_analysis((select company_id from public.customer_purchase_orders where id = p_po), p_po) a
  where a.source_row_number = p_row $$;
create function rls_test.today() returns date language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e57300-0000-4000-8000-0000000000a1'), ('company_b', 'e7e57300-0000-4000-8000-0000000000b1'),
  ('sales',  'e7e57300-0000-4000-8000-000000000002'), ('im', 'e7e57300-0000-4000-8000-000000000003'),
  ('adm',    'e7e57300-0000-4000-8000-000000000004'), ('viewer', 'e7e57300-0000-4000-8000-000000000005'),
  ('prod',   'e7e57300-0000-4000-8000-000000000006'), ('b_sales', 'e7e57300-0000-4000-8000-000000000007'),
  ('pa', 'e7e57300-0000-4000-8000-0000000000c1'), ('pb', 'e7e57300-0000-4000-8000-0000000000c2'),
  ('pc', 'e7e57300-0000-4000-8000-0000000000c3'), ('pk', 'e7e57300-0000-4000-8000-0000000000c4'),
  ('pe', 'e7e57300-0000-4000-8000-0000000000c5'), ('amb1', 'e7e57300-0000-4000-8000-0000000000c6'),
  ('amb2', 'e7e57300-0000-4000-8000-0000000000c7'), ('b_pa', 'e7e57300-0000-4000-8000-0000000000d1'),
  ('w1', 'e7e57300-0000-4000-8000-0000000000e1'), ('w2', 'e7e57300-0000-4000-8000-0000000000e2'), ('wb', 'e7e57300-0000-4000-8000-0000000000e3'),
  ('rej', 'e7e57300-0000-4000-8000-0000000000f1'), ('c1', 'e7e57300-0000-4000-8000-0000000000aa'), ('c_b', 'e7e57300-0000-4000-8000-0000000000bb');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code) values
  (rls_test.id('company_a'), 'PO Test A', 'PO Test A', 'POA'), (rls_test.id('company_b'), 'PO Test B', 'PO Test B', 'POB');
insert into auth.users (id, email) select id, key || '@po.example.invalid' from rls_test.ids where key in ('sales', 'im', 'adm', 'viewer', 'prod', 'b_sales');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true
  where id in (rls_test.id('sales'), rls_test.id('im'), rls_test.id('adm'), rls_test.id('viewer'), rls_test.id('prod'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_sales');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('sales'),   rls_test.id('company_a'), rls_test.id('role_sales_manager')),
  (rls_test.id('im'),      rls_test.id('company_a'), rls_test.id('role_inventory_manager')),
  (rls_test.id('adm'),     rls_test.id('company_a'), rls_test.id('role_admin')),
  (rls_test.id('viewer'),  rls_test.id('company_a'), rls_test.id('role_management_viewer')),
  (rls_test.id('prod'),    rls_test.id('company_a'), rls_test.id('role_production_manager')),
  (rls_test.id('b_sales'), rls_test.id('company_b'), rls_test.id('role_sales_manager'));

insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, track_batches, track_expiry, barcode, status) values
  (rls_test.id('pa'),   rls_test.id('company_a'), 'PO-BASIN', 'Hybrid basin',   'FINISHED_GOOD', 'HYBRID',     'PCS', false, false, '8900000000011', 'ACTIVE'),
  (rls_test.id('pb'),   rls_test.id('company_a'), 'PO-SEAL',  'Batch sealant',  'FINISHED_GOOD', 'OUTSOURCED', 'BOX', true,  true,  null, 'ACTIVE'),
  (rls_test.id('pc'),   rls_test.id('company_a'), 'PO-WC-01', 'Closet 01',      'FINISHED_GOOD', 'IN_HOUSE',   'PCS', false, false, null, 'ACTIVE'),
  (rls_test.id('pk'),   rls_test.id('company_a'), 'PO-KG',    'Grout (kg)',     'FINISHED_GOOD', 'OUTSOURCED', 'KG',  false, false, null, 'ACTIVE'),
  (rls_test.id('pe'),   rls_test.id('company_a'), 'PO-OLD',   'Old model',      'FINISHED_GOOD', 'IN_HOUSE',   'PCS', false, false, null, 'INACTIVE'),
  (rls_test.id('amb1'), rls_test.id('company_a'), 'AMB1',     'Ambiguous one',  'FINISHED_GOOD', 'IN_HOUSE',   'PCS', false, false, null, 'ACTIVE'),
  (rls_test.id('amb2'), rls_test.id('company_a'), 'AMB-1',    'Ambiguous dash', 'FINISHED_GOOD', 'IN_HOUSE',   'PCS', false, false, null, 'ACTIVE'),
  (rls_test.id('b_pa'), rls_test.id('company_b'), 'PO-BASIN', 'B basin',        'FINISHED_GOOD', 'IN_HOUSE',   'PCS', false, false, null, 'ACTIVE');

insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Main', true), (rls_test.id('w2'), rls_test.id('company_a'), 'W2', 'Second', false),
  (rls_test.id('wb'), rls_test.id('company_b'), 'W1', 'B main', true);
insert into public.inventory_locations (id, company_id, warehouse_id, location_code, location_name, location_type, stock_usage) values
  (rls_test.id('rej'), rls_test.id('company_a'), rls_test.id('w1'), 'REJECT', 'Rejected bay', 'AREA', 'REJECTED');
insert into rls_test.ids (key, id)
select case warehouse_id when rls_test.id('w1') then 'g1' when rls_test.id('w2') then 'g2' else 'gb' end, id
from public.inventory_locations where location_code = 'GENERAL' and warehouse_id in (rls_test.id('w1'), rls_test.id('w2'), rls_test.id('wb'));

select rls_test.ok('RLS enabled on every public table (including Phase 6 tables)',
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity));
select rls_test.ok('clients cannot write PO, line, allocation-run, snapshot or mapping tables directly',
  not exists (select 1 from unnest(array['customer_purchase_orders', 'customer_purchase_order_lines', 'customer_po_import_batches', 'customer_po_events',
    'customer_po_allocation_runs', 'customer_po_analysis_snapshots', 'customer_po_shortage_notes', 'customer_product_codes']) t
    where has_table_privilege('authenticated', 'public.' || t, 'INSERT,UPDATE,DELETE')));
select rls_test.ok('no separate allocation or stock table: allocations are stock_reservations',
  -- Phase 8's invoice/payment allocation tables hold billed quantities and money, not stock.
  not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name ilike '%allocation%' and table_type = 'BASE TABLE'
    and table_name not in ('customer_po_allocation_runs', 'sales_invoice_dispatch_allocations', 'invoice_payment_allocations')));

-- Stock (Phase 4 functions)
set local role authenticated;
select rls_test.claims('im');
select rls_test.call(format($q$ select public.inventory_post_receipt(%L, %L, 10, 'IN_HOUSE', p_unit_cost => 100, p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('pa'), rls_test.id('g1')));
select rls_test.call(format($q$ select public.inventory_post_receipt(%L, %L, 6, 'OUTSOURCED', p_unit_cost => 120, p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('pa'), rls_test.id('g1')));
select rls_test.call(format($q$ select public.inventory_post_receipt(%L, %L, 4, 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('pa'), rls_test.id('g2')));
select rls_test.call(format($q$ select public.inventory_post_receipt(%L, %L, 5, 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('pa'), rls_test.id('rej')));
select rls_test.call(format($q$ select public.inventory_post_receipt(%L, %L, 8, 'OUTSOURCED', p_batch_number => 'S-1', p_expiry_date => %L, p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('pb'), rls_test.id('g1'), rls_test.today() + 30));
select rls_test.call(format($q$ select public.inventory_post_receipt(%L, %L, 5, 'OUTSOURCED', p_batch_number => 'S-0', p_expiry_date => %L, p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('pb'), rls_test.id('g1'), rls_test.today() - 1));
select rls_test.call(format($q$ select public.inventory_post_receipt(%L, %L, 2, 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('pc'), rls_test.id('g1')));
select rls_test.call(format($q$ select public.inventory_post_receipt(%L, %L, 20, 'OUTSOURCED', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('pk'), rls_test.id('g1')));
select rls_test.set('unknown_open', rls_test.call(format($q$ select public.inventory_submit_opening_stock(%L::jsonb, 'MANUAL', null, null, gen_random_uuid()) $q$,
  jsonb_build_array(jsonb_build_object('line_no', 1, 'product_id', rls_test.id('pa'), 'location_id', rls_test.id('g1'), 'source_type', 'UNKNOWN', 'quantity', 3, 'effective_date', rls_test.today())))));
select rls_test.claims('adm');
select rls_test.call(format($q$ select public.inventory_review_opening_stock(%L, 'APPROVE', null, gen_random_uuid()) $q$, rls_test.gid('unknown_open', 'opening_batch_id')));
select rls_test.claims('im');
select rls_test.expect_call_ok('setup: another order reserves 2 in-house basins at W1 (generic reservation)', 'other_res',
  format($q$ select public.inventory_create_reservation(%L, %L, 2, 'MANUAL', 'OTHER-1', p_source_type => 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('pa'), rls_test.id('g1')));
select rls_test.ok('setup: basin stock = 10+6 (W1) + 4 (W2) + 5 rejected + 3 unverified; 2 reserved',
  rls_test.on_hand(rls_test.id('pa')) = 28 and rls_test.reserved(rls_test.id('pa')) = 2);

-- Customer master
select rls_test.claims('viewer');
select rls_test.expect_error('customers: Management Viewer cannot create customers',
  format($q$ insert into public.customers (company_id, customer_code, customer_name) values (%L, 'X1', 'X') $q$, rls_test.id('company_a')));
select rls_test.claims('sales');
select rls_test.expect_call_ok('customers: Sales Manager creates a customer record', 'c1_row',
  format($q$ insert into public.customers (company_id, customer_code, customer_name, contact_email) values (%L, 'acme', 'Acme  Ltd', 'Buyer@Acme.example') returning to_jsonb(customers.*) $q$,
    rls_test.id('company_a')));
reset role;
update rls_test.ids set id = (rls_test.get('c1_row') ->> 'id')::uuid where key = 'c1';
set local role authenticated;
select rls_test.claims('sales');
select rls_test.ok('customers: code upper-cased, name and e-mail normalised',
  rls_test.get('c1_row') ->> 'customer_code' = 'ACME' and rls_test.get('c1_row') ->> 'customer_name' = 'Acme Ltd' and rls_test.get('c1_row') ->> 'contact_email' = 'buyer@acme.example',
  rls_test.get('c1_row')::text);
select rls_test.expect_error('customers: duplicate customer code is rejected',
  format($q$ insert into public.customers (company_id, customer_code, customer_name) values (%L, 'ACME', 'Other') $q$, rls_test.id('company_a')));

-- ===========================================================================
-- IMPORT, VALIDATION, MATCHING
-- ===========================================================================
select rls_test.set('header', jsonb_build_object('customer_id', rls_test.id('c1'), 'customer_po_number', 'PO-1001', 'po_date', rls_test.today() - 2,
  'required_delivery_date', rls_test.today() + 5, 'currency', 'INR'));
select rls_test.set('lines', jsonb_build_array(
  jsonb_build_object('source_row_number', 2, 'sku', 'PO-BASIN', 'description', 'Basin', 'quantity', 12, 'unit', 'pcs', 'unit_price', 950.5),
  jsonb_build_object('source_row_number', 3, 'barcode', '8900000000011', 'description', 'Basin again', 'quantity', 3),
  jsonb_build_object('source_row_number', 4, 'sku', 'AMB 1', 'customer_sku', 'AMB 1', 'quantity', 1),
  jsonb_build_object('source_row_number', 5, 'sku', 'XYZ-404', 'description', 'Unknown thing', 'quantity', 2),
  jsonb_build_object('source_row_number', 6, 'sku', 'po wc 01', 'quantity', 5),
  jsonb_build_object('source_row_number', 7, 'sku', 'PO-KG', 'quantity', 5, 'unit', 'PCS'),
  jsonb_build_object('source_row_number', 8, 'sku', 'PO-OLD', 'quantity', 1),
  jsonb_build_object('source_row_number', 9, 'sku', 'PO-SEAL', 'quantity', 6)));
select rls_test.set('file', jsonb_build_object('name', 'acme-po-1001.xlsx', 'hash', repeat('a', 64), 'size', 12000, 'sheet', 'PO', 'rows_read', 9,
  'rejected_rows', jsonb_build_array(jsonb_build_object('row', 10, 'message', 'Quantity must be greater than zero'))));

select rls_test.claims('viewer');
select rls_test.expect_call_error('import: Management Viewer cannot import POs',
  format($q$ select public.customer_po_import(%L::jsonb, %L::jsonb, %L::jsonb, null, gen_random_uuid()) $q$, rls_test.get('header'), rls_test.get('lines'), rls_test.get('file')), 'not allowed');
select rls_test.claims('prod');
select rls_test.expect_call_error('import: Production Manager cannot import POs',
  format($q$ select public.customer_po_import(%L::jsonb, %L::jsonb, %L::jsonb, null, gen_random_uuid()) $q$, rls_test.get('header'), rls_test.get('lines'), rls_test.get('file')), 'not allowed');

select rls_test.claims('sales');
select rls_test.set('bad', rls_test.call(format($q$ select public.customer_po_import(%L::jsonb, %L::jsonb, %L::jsonb, null, gen_random_uuid()) $q$,
  jsonb_build_object('customer_id', rls_test.id('c1'), 'customer_po_number', 'PO-BAD', 'po_date', rls_test.today()),
  jsonb_build_array(jsonb_build_object('source_row_number', 2, 'sku', 'PO-BASIN', 'quantity', -1),
                    jsonb_build_object('source_row_number', 3, 'sku', 'PO-BASIN', 'quantity', 0),
                    jsonb_build_object('source_row_number', 4, 'sku', 'PO-BASIN', 'quantity', 'abc'),
                    jsonb_build_object('source_row_number', 5, 'quantity', 2),
                    jsonb_build_object('source_row_number', 6, 'sku', 'PO-BASIN', 'quantity', 1, 'currency', 'RUPEES')),
  jsonb_build_object('name', 'bad.csv'))));
select rls_test.ok('import: negative, zero and non-numeric quantities, missing identification and bad currency are rejected per row; no PO created',
  (rls_test.get('bad') ->> 'ok') = 'false' and jsonb_array_length(rls_test.get('bad') -> 'errors') = 5
  and not exists (select 1 from public.customer_purchase_orders where customer_po_number = 'PO-BAD'), rls_test.get('bad')::text);
select rls_test.expect_call_error('import: PO date in the future is rejected',
  format($q$ select public.customer_po_import(%L::jsonb, %L::jsonb, %L::jsonb, null, gen_random_uuid()) $q$,
    jsonb_build_object('customer_id', rls_test.id('c1'), 'customer_po_number', 'PO-FUT', 'po_date', rls_test.today() + 10), rls_test.get('lines'), jsonb_build_object('name', 'x.csv')), 'future');
select rls_test.expect_call_error('import: delivery date before PO date is rejected',
  format($q$ select public.customer_po_import(%L::jsonb, %L::jsonb, %L::jsonb, null, gen_random_uuid()) $q$,
    jsonb_build_object('customer_id', rls_test.id('c1'), 'customer_po_number', 'PO-DD', 'po_date', rls_test.today(), 'required_delivery_date', rls_test.today() - 3), rls_test.get('lines'), jsonb_build_object('name', 'x.csv')), 'delivery date');

-- Preview: read only, matching + availability
select rls_test.set('preview', public.customer_po_preview(rls_test.get('header'), rls_test.get('lines'), repeat('a', 64)));
select rls_test.ok('preview: matches without creating anything (exact SKU, barcode→duplicate, ambiguous, unmatched, normalized, unit mismatch, inactive)',
  (select string_agg(l ->> 'status', ',' order by (l ->> 'source_row_number')::int) from jsonb_array_elements(rls_test.get('preview') -> 'lines') l)
    = 'MATCHED,DUPLICATE_REVIEW,AMBIGUOUS,UNMATCHED,MATCHED,INVALID,INVALID,MATCHED'
  and not exists (select 1 from public.customer_purchase_orders where customer_po_number = 'PO-1001'), rls_test.get('preview')::text);
select rls_test.ok('preview: unit mismatch and availability status are reported per line',
  (select l ->> 'availability_status' = 'UNIT_MISMATCH' from jsonb_array_elements(rls_test.get('preview') -> 'lines') l where (l ->> 'source_row_number')::int = 7)
  and (select (l ->> 'available_for_line')::numeric = 12 and l ->> 'availability_status' = 'FULLY_AVAILABLE' from jsonb_array_elements(rls_test.get('preview') -> 'lines') l where (l ->> 'source_row_number')::int = 2));

select rls_test.expect_call_ok('import: valid PO imported after confirmation', 'po1',
  format($q$ select public.customer_po_import(%L::jsonb, %L::jsonb, %L::jsonb, null, 'e7e5f300-0000-4000-8000-000000000001') $q$, rls_test.get('header'), rls_test.get('lines'), rls_test.get('file')));
select rls_test.ok('import: PO created with 8 lines; invalid and unmatched lines keep it in VALIDATION_REQUIRED',
  (rls_test.get('po1') ->> 'ok') = 'true' and (rls_test.get('po1') ->> 'lines')::int = 8 and (rls_test.get('po1') ->> 'status') = 'VALIDATION_REQUIRED'
  and (rls_test.get('po1') ->> 'matched')::int = 3 and (rls_test.get('po1') ->> 'ambiguous')::int = 1 and (rls_test.get('po1') ->> 'unmatched')::int = 1
  and (rls_test.get('po1') ->> 'invalid')::int = 2 and (rls_test.get('po1') ->> 'duplicate_review')::int = 1, rls_test.get('po1')::text);
select rls_test.ok('matching: methods recorded — exact SKU, barcode, normalized code; never by description',
  (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).matching_method = 'SKU' and (rls_test.line(rls_test.gid('po1', 'po_id'), 3)).matching_method = 'BARCODE'
  and (rls_test.line(rls_test.gid('po1', 'po_id'), 6)).matching_method = 'NORMALIZED_CODE' and (rls_test.line(rls_test.gid('po1', 'po_id'), 6)).product_id = rls_test.id('pc')
  and (rls_test.line(rls_test.gid('po1', 'po_id'), 5)).product_id is null);
select rls_test.ok('matching: ambiguous code lists both candidates; unknown product is not created',
  (rls_test.line(rls_test.gid('po1', 'po_id'), 4)).candidate_product_ids @> array[rls_test.id('amb1'), rls_test.id('amb2')]
  and not exists (select 1 from public.products where sku ilike 'XYZ%'));
select rls_test.ok('matching: unit mismatch and inactive product are INVALID with reasons; original line values kept',
  (rls_test.line(rls_test.gid('po1', 'po_id'), 7)).status_reason = 'UNIT_MISMATCH' and (rls_test.line(rls_test.gid('po1', 'po_id'), 8)).status_reason = 'PRODUCT_INACTIVE'
  and (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).unit_price = 950.5 and (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).uploaded_quantity = 12);
select rls_test.ok('import: batch records rows read, valid, rejected and the rejected-row errors',
  (select rows_read = 9 and valid_rows = 8 and invalid_rows = 1 and validation_status = 'VALID_WITH_REJECTED_ROWS' and jsonb_array_length(error_summary) = 1
   from public.customer_po_import_batches where id = (rls_test.po(rls_test.gid('po1', 'po_id'))).import_batch_id));

-- Duplicate protection
select rls_test.set('po1_retry', rls_test.call(format($q$ select public.customer_po_import(%L::jsonb, %L::jsonb, %L::jsonb, null, 'e7e5f300-0000-4000-8000-000000000001') $q$,
  rls_test.get('header'), rls_test.get('lines'), rls_test.get('file'))));
select rls_test.ok('duplicate: a retried import (same request id) returns the same PO and creates nothing',
  rls_test.gid('po1_retry', 'po_id') = rls_test.gid('po1', 'po_id') and (rls_test.get('po1_retry') ->> 'duplicate') = 'true'
  and (select count(*) = 1 from public.customer_purchase_orders where customer_po_number = 'PO-1001'));
select rls_test.set('dup_file', rls_test.call(format($q$ select public.customer_po_import(%L::jsonb, %L::jsonb, %L::jsonb, null, gen_random_uuid()) $q$,
  rls_test.get('header') || '{"customer_po_number": "PO-OTHER"}', rls_test.get('lines'), rls_test.get('file'))));
select rls_test.ok('duplicate: the same file (fingerprint) cannot be imported twice', (rls_test.get('dup_file') ->> 'reason') = 'DUPLICATE_FILE', rls_test.get('dup_file')::text);
select rls_test.set('dup_po', rls_test.call(format($q$ select public.customer_po_import(%L::jsonb, %L::jsonb, %L::jsonb, null, gen_random_uuid()) $q$,
  jsonb_build_object('customer_name', 'ACME   LTD', 'customer_po_number', 'po-1001', 'po_date', rls_test.today()), rls_test.get('lines'),
  jsonb_build_object('name', 'other.xlsx', 'hash', repeat('b', 64)))));
select rls_test.ok('duplicate: same customer (by record or name) + PO number is reported with the existing PO, not imported again',
  (rls_test.get('dup_po') ->> 'reason') = 'DUPLICATE_PO' and (rls_test.get('dup_po') -> 'existing' ->> 'po_id')::uuid = rls_test.gid('po1', 'po_id'), rls_test.get('dup_po')::text);

-- Line review
select rls_test.claims('viewer');
select rls_test.expect_call_error('review: Management Viewer cannot match lines',
  format($q$ select public.customer_po_line_action(%L, 'MATCH', %L) $q$, (rls_test.line(rls_test.gid('po1', 'po_id'), 4)).id, rls_test.id('amb1')), 'not allowed');
select rls_test.claims('sales');
select rls_test.expect_call_error('review: cannot match to another company''s product',
  format($q$ select public.customer_po_line_action(%L, 'MATCH', %L) $q$, (rls_test.line(rls_test.gid('po1', 'po_id'), 4)).id, rls_test.id('b_pa')), 'not found');
select rls_test.expect_call_ok('review: ambiguous line matched manually and the customer code remembered', 'm4',
  format($q$ select public.customer_po_line_action(%L, 'MATCH', %L, true, 'Customer confirmed') $q$, (rls_test.line(rls_test.gid('po1', 'po_id'), 4)).id, rls_test.id('amb1')));
select rls_test.ok('review: manual match recorded with user and method; verified mapping saved',
  (rls_test.line(rls_test.gid('po1', 'po_id'), 4)).matching_method = 'MANUAL' and (rls_test.line(rls_test.gid('po1', 'po_id'), 4)).matched_by = rls_test.id('sales')
  and exists (select 1 from public.customer_product_codes where customer_id = rls_test.id('c1') and customer_sku = 'AMB 1' and product_id = rls_test.id('amb1')));
select rls_test.expect_call_ok('review: unmatched product flagged for Product Master creation', 'f5',
  format($q$ select public.customer_po_line_action(%L, 'FLAG_NEW_PRODUCT') $q$, (rls_test.line(rls_test.gid('po1', 'po_id'), 5)).id));
select rls_test.expect_call_error('review: excluding a line requires a reason',
  format($q$ select public.customer_po_line_action(%L, 'EXCLUDE') $q$, (rls_test.line(rls_test.gid('po1', 'po_id'), 5)).id), 'reason');
select rls_test.call(format($q$ select public.customer_po_line_action(%L, 'EXCLUDE', p_note => 'Not our product; customer informed') $q$, (rls_test.line(rls_test.gid('po1', 'po_id'), 5)).id));
select rls_test.call(format($q$ select public.customer_po_line_action(%L, 'EXCLUDE', p_note => 'Discontinued model') $q$, (rls_test.line(rls_test.gid('po1', 'po_id'), 8)).id));
select rls_test.expect_call_ok('review: repeated product confirmed as a separate demand (original lines kept)', 'd3',
  format($q$ select public.customer_po_line_action(%L, 'CONFIRM_DUPLICATE', p_note => 'Second delivery point') $q$, (rls_test.line(rls_test.gid('po1', 'po_id'), 3)).id));
select rls_test.expect_call_error('review: correcting quantity/unit needs a documented reason',
  format($q$ select public.customer_po_line_action(%L, 'CORRECT', p_quantity => 5, p_unit => 'KG') $q$, (rls_test.line(rls_test.gid('po1', 'po_id'), 7)).id), 'reason');
select rls_test.expect_call_ok('review: unit corrected to the product unit (5 KG) with reason', 'c7',
  format($q$ select public.customer_po_line_action(%L, 'CORRECT', p_note => 'Customer confirmed 5 KG', p_quantity => 5, p_unit => 'KG') $q$, (rls_test.line(rls_test.gid('po1', 'po_id'), 7)).id));
select rls_test.ok('review: all lines resolved — PO is READY_FOR_ALLOCATION; corrected line keeps the uploaded unit',
  (rls_test.get('c7') ->> 'po_status') = 'READY_FOR_ALLOCATION' and (rls_test.line(rls_test.gid('po1', 'po_id'), 7)).uploaded_unit = 'PCS'
  and (rls_test.line(rls_test.gid('po1', 'po_id'), 7)).line_status = 'MATCHED', rls_test.get('c7')::text);

-- ===========================================================================
-- AVAILABILITY
-- ===========================================================================
select rls_test.ok('availability: reserved, rejected-location and unverified-source stock excluded (basin available 18 of 28 on hand)',
  (rls_test.aline(rls_test.gid('po1', 'po_id'), 2) ->> 'available')::numeric = 18 and (rls_test.aline(rls_test.gid('po1', 'po_id'), 2) ->> 'reserved')::numeric = 2
  and (rls_test.aline(rls_test.gid('po1', 'po_id'), 2) ->> 'unknown_on_hand')::numeric = 3 and (rls_test.aline(rls_test.gid('po1', 'po_id'), 2) ->> 'ineligible_on_hand')::numeric = 8,
  (rls_test.aline(rls_test.gid('po1', 'po_id'), 2))::text);
select rls_test.ok('availability: in-house (8+4) and outsourced (6) are separated by actual lot source',
  (rls_test.aline(rls_test.gid('po1', 'po_id'), 2) ->> 'in_house_available')::numeric = 12 and (rls_test.aline(rls_test.gid('po1', 'po_id'), 2) ->> 'outsourced_available')::numeric = 6
  and (rls_test.aline(rls_test.gid('po1', 'po_id'), 2) ->> 'in_house_on_hand')::numeric = 14);
select rls_test.ok('availability: lines of the same product never count the same stock twice (12 then 3 of 18)',
  (rls_test.aline(rls_test.gid('po1', 'po_id'), 2) ->> 'available_for_line')::numeric = 12 and (rls_test.aline(rls_test.gid('po1', 'po_id'), 3) ->> 'available_for_line')::numeric = 3);
select rls_test.ok('availability: expired batch excluded (sealant 8 of 13 eligible) and shortage = max(ordered − available, 0) for closets (5 vs 2)',
  (rls_test.aline(rls_test.gid('po1', 'po_id'), 9) ->> 'available')::numeric = 8 and rls_test.aline(rls_test.gid('po1', 'po_id'), 9) ->> 'availability_status' = 'FULLY_AVAILABLE'
  and (rls_test.aline(rls_test.gid('po1', 'po_id'), 6) ->> 'shortage_before')::numeric = 3 and rls_test.aline(rls_test.gid('po1', 'po_id'), 6) ->> 'availability_status' = 'PARTIALLY_AVAILABLE');
select rls_test.ok('availability: line stock shows ineligible lots with reasons (expired, rejected, unverified)',
  (select count(*) = 1 from jsonb_array_elements(public.customer_po_line_stock((rls_test.line(rls_test.gid('po1', 'po_id'), 9)).id)) s where s ->> 'ineligible_reason' = 'Expired')
  and (select count(*) = 2 from jsonb_array_elements(public.customer_po_line_stock((rls_test.line(rls_test.gid('po1', 'po_id'), 2)).id)) s
       where s ->> 'ineligible_reason' in ('Rejected goods (non-saleable)', 'Unverified source (review required)')));
select rls_test.call(format($q$ select public.customer_po_update_header(%L, %L, %L, null) $q$, rls_test.gid('po1', 'po_id'), rls_test.today() + 5, rls_test.id('w1')));
select rls_test.ok('availability: a fulfilment warehouse limits stock; other-warehouse stock reported separately (W1 14, W2 4)',
  (rls_test.aline(rls_test.gid('po1', 'po_id'), 2) ->> 'available')::numeric = 14 and (rls_test.aline(rls_test.gid('po1', 'po_id'), 2) ->> 'other_warehouse_available')::numeric = 4
  and (rls_test.aline(rls_test.gid('po1', 'po_id'), 3) ->> 'available_for_line')::numeric = 2 and rls_test.aline(rls_test.gid('po1', 'po_id'), 3) ->> 'availability_status' = 'PARTIALLY_AVAILABLE');
select rls_test.call(format($q$ select public.customer_po_update_header(%L, %L, null, null) $q$, rls_test.gid('po1', 'po_id'), rls_test.today() + 5));

-- Proposals (read only)
select rls_test.ok('strategy: OUTSOURCED_FIRST proposes the outsourced lot first for the hybrid basin',
  (select (e ->> 'source_type') = 'OUTSOURCED' from jsonb_array_elements(public.customer_po_propose(rls_test.gid('po1', 'po_id'), 'OUTSOURCED_FIRST')) with ordinality x(e, n)
   where (e ->> 'line_id')::uuid = (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).id order by n limit 1));
select rls_test.ok('strategy: WAREHOUSE_PRIORITY [W2] proposes W2 first',
  (select (e ->> 'warehouse_id')::uuid = rls_test.id('w2') from jsonb_array_elements(public.customer_po_propose(rls_test.gid('po1', 'po_id'), 'WAREHOUSE_PRIORITY', array[rls_test.id('w2')])) with ordinality x(e, n)
   where (e ->> 'line_id')::uuid = (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).id order by n limit 1));
select rls_test.ok('strategy: proposals never exceed eligible stock or reserve anything', rls_test.reserved(rls_test.id('pa')) = 2
  and (select sum((e ->> 'quantity')::numeric) <= 18 from jsonb_array_elements(public.customer_po_propose(rls_test.gid('po1', 'po_id'), 'EARLIEST_BATCH')) e
       where (e ->> 'line_id')::uuid in ((rls_test.line(rls_test.gid('po1', 'po_id'), 2)).id, (rls_test.line(rls_test.gid('po1', 'po_id'), 3)).id)));

-- ===========================================================================
-- ALLOCATION
-- ===========================================================================
select rls_test.claims('viewer');
select rls_test.expect_call_error('allocate: Management Viewer cannot allocate stock',
  format($q$ select public.customer_po_allocate(%L, 'IN_HOUSE_FIRST', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('po1', 'po_id')), 'not allowed');
select rls_test.claims('sales');
select rls_test.expect_call_error('allocate: an all-or-nothing allocation with a shortage fails and reserves nothing',
  format($q$ select public.customer_po_allocate(%L, 'IN_HOUSE_FIRST', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('po1', 'po_id')), 'Nothing was reserved');
select rls_test.ok('allocate: failed allocation rolled back (no PO reservations, balances unchanged)',
  rls_test.po_reserved(rls_test.gid('po1', 'po_id')) = 0 and rls_test.reserved(rls_test.id('pa')) = 2 and rls_test.reserved(rls_test.id('pc')) = 0);
select rls_test.expect_call_error('allocate: manual quantity above the line''s outstanding quantity is refused',
  format($q$ select public.customer_po_allocate(%L, 'MANUAL', null, %L::jsonb, true, null, gen_random_uuid()) $q$, rls_test.gid('po1', 'po_id'),
    jsonb_build_array(jsonb_build_object('line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).id, 'balance_id', rls_test.balance(rls_test.id('pa'), rls_test.id('g1'), 'OUTSOURCED'), 'quantity', 13))), 'exceeds');
select rls_test.expect_call_error('allocate: manual quantity above the lot''s available stock is refused (over-allocation)',
  format($q$ select public.customer_po_allocate(%L, 'MANUAL', null, %L::jsonb, true, null, gen_random_uuid()) $q$, rls_test.gid('po1', 'po_id'),
    jsonb_build_array(jsonb_build_object('line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).id, 'balance_id', rls_test.balance(rls_test.id('pa'), rls_test.id('g1'), 'OUTSOURCED'), 'quantity', 7))), 'available');
select rls_test.expect_call_error('allocate: rejected-location stock cannot be allocated',
  format($q$ select public.customer_po_allocate(%L, 'MANUAL', null, %L::jsonb, true, null, gen_random_uuid()) $q$, rls_test.gid('po1', 'po_id'),
    jsonb_build_array(jsonb_build_object('line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).id, 'balance_id', rls_test.balance(rls_test.id('pa'), rls_test.id('rej'), 'IN_HOUSE'), 'quantity', 1))), 'not eligible');
select rls_test.expect_call_error('allocate: expired batch cannot be allocated',
  format($q$ select public.customer_po_allocate(%L, 'MANUAL', null, %L::jsonb, true, null, gen_random_uuid()) $q$, rls_test.gid('po1', 'po_id'),
    jsonb_build_array(jsonb_build_object('line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 9)).id, 'balance_id', rls_test.lot_balance(rls_test.id('pb'), 'S-0'), 'quantity', 1))), 'Expired');
select rls_test.expect_call_error('allocate: unverified-source stock cannot be allocated',
  format($q$ select public.customer_po_allocate(%L, 'MANUAL', null, %L::jsonb, true, null, gen_random_uuid()) $q$, rls_test.gid('po1', 'po_id'),
    jsonb_build_array(jsonb_build_object('line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).id, 'balance_id', rls_test.balance(rls_test.id('pa'), rls_test.id('g1'), 'UNKNOWN'), 'quantity', 1))), 'Unverified');
select rls_test.expect_call_error('allocate: a lot of a different product is refused',
  format($q$ select public.customer_po_allocate(%L, 'MANUAL', null, %L::jsonb, true, null, gen_random_uuid()) $q$, rls_test.gid('po1', 'po_id'),
    jsonb_build_array(jsonb_build_object('line_id', (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).id, 'balance_id', rls_test.balance(rls_test.id('pc'), rls_test.id('g1'), 'IN_HOUSE'), 'quantity', 1))), 'does not hold');

select rls_test.expect_call_ok('allocate: IN_HOUSE_FIRST partial allocation reserves what is eligible', 'alloc1',
  format($q$ select public.customer_po_allocate(%L, 'IN_HOUSE_FIRST', null, null, true, 'First pass', 'e7e5f300-0000-4000-8000-000000000010') $q$, rls_test.gid('po1', 'po_id')));
select rls_test.set('alloc1_retry', rls_test.call(format($q$ select public.customer_po_allocate(%L, 'IN_HOUSE_FIRST', null, null, true, 'First pass', 'e7e5f300-0000-4000-8000-000000000010') $q$, rls_test.gid('po1', 'po_id'))));
select rls_test.ok('allocate: a retried allocation (same request id) reserves nothing more',
  (rls_test.get('alloc1_retry') ->> 'duplicate') = 'true' and rls_test.po_reserved(rls_test.gid('po1', 'po_id')) = 12 + 3 + 2 + 5 + 6);
select rls_test.ok('allocate: basin line 1 takes in-house stock first across both warehouses (8 W1 + 4 W2); line 2 then outsourced',
  (select sum(quantity) = 12 and bool_and(b.source_type = 'IN_HOUSE') and count(distinct r.warehouse_id) = 2
   from public.stock_reservations r join public.inventory_balances b on b.batch_id = r.batch_id and b.location_id = r.location_id
   where r.reference_id = (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).id)
  and (select sum(quantity) = 3 and bool_and(b.source_type = 'OUTSOURCED')
   from public.stock_reservations r join public.inventory_balances b on b.batch_id = r.batch_id and b.location_id = r.location_id
   where r.reference_id = (rls_test.line(rls_test.gid('po1', 'po_id'), 3)).id));
select rls_test.ok('allocate: allocation reserves but never reduces on-hand stock; status PARTIALLY_ALLOCATED with closet shortage 3',
  rls_test.on_hand(rls_test.id('pa')) = 28 and rls_test.reserved(rls_test.id('pa')) = 17 and (rls_test.get('alloc1') ->> 'status') = 'PARTIALLY_ALLOCATED'
  and (select (s ->> 'short')::numeric = 3 from jsonb_array_elements(rls_test.get('alloc1') -> 'shortages') s where s ->> 'sku' = 'PO-WC-01')
  and (rls_test.aline(rls_test.gid('po1', 'po_id'), 6) ->> 'shortage_after')::numeric = 3, rls_test.get('alloc1')::text);
select rls_test.ok('allocate: expired sealant batch was skipped (allocated from S-1 only)',
  (select bool_and(bt.batch_number = 'S-1') from public.stock_reservations r join public.inventory_batches bt on bt.id = r.batch_id
   where r.reference_id = (rls_test.line(rls_test.gid('po1', 'po_id'), 9)).id));
select rls_test.ok('allocate: run recorded with strategy, user and result', exists (select 1 from public.customer_po_allocation_runs
  where purchase_order_id = rls_test.gid('po1', 'po_id') and run_type = 'COMMITTED' and strategy = 'IN_HOUSE_FIRST' and created_by = rls_test.id('sales')));
select rls_test.expect_call_error('allocate: lines with allocations cannot be re-matched or corrected until released',
  format($q$ select public.customer_po_line_action(%L, 'CORRECT', p_note => 'Change quantity', p_quantity => 1) $q$, (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).id), 'Release');
select rls_test.ok('allocate: reserved never exceeds on hand on any lot',
  (select bool_and(reserved <= on_hand) from public.inventory_balances where company_id = rls_test.id('company_a')));

-- Competing PO for the same basins: only the 3 remaining eligible units can be taken.
select rls_test.expect_call_ok('compete: second PO imported for 10 basins', 'po2',
  format($q$ select public.customer_po_import(%L::jsonb, %L::jsonb, %L::jsonb, null, gen_random_uuid()) $q$,
    jsonb_build_object('customer_id', rls_test.id('c1'), 'customer_po_number', 'PO-2002', 'po_date', rls_test.today()),
    jsonb_build_array(jsonb_build_object('source_row_number', 2, 'customer_sku', 'AMB 1', 'quantity', 1), jsonb_build_object('source_row_number', 3, 'sku', 'PO-BASIN', 'quantity', 10)),
    jsonb_build_object('name', 'po2.csv', 'hash', repeat('c', 64))));
select rls_test.ok('matching: the remembered customer code matches automatically on a later PO (CUSTOMER_SKU)',
  (rls_test.line(rls_test.gid('po2', 'po_id'), 2)).matching_method = 'CUSTOMER_SKU' and (rls_test.line(rls_test.gid('po2', 'po_id'), 2)).product_id = rls_test.id('amb1'));
select rls_test.expect_call_error('compete: all-or-nothing allocation of the second PO fails (stock already reserved)',
  format($q$ select public.customer_po_allocate(%L, 'EARLIEST_BATCH', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('po2', 'po_id')), 'Nothing was reserved');
select rls_test.expect_call_ok('compete: partial allocation of the second PO takes only the 3 units left', 'alloc2',
  format($q$ select public.customer_po_allocate(%L, 'EARLIEST_BATCH', null, null, true, null, gen_random_uuid()) $q$, rls_test.gid('po2', 'po_id')));
select rls_test.ok('compete: the two POs never hold the same units (18 eligible = 15 + 3; plus 2 reserved by another order)',
  rls_test.reserved(rls_test.id('pa')) = 20 and (select sum(r.quantity) = 3 from public.stock_reservations r
    where r.reference_id = (rls_test.line(rls_test.gid('po2', 'po_id'), 3)).id and r.reservation_status = 'ACTIVE'), rls_test.get('alloc2')::text);

-- ===========================================================================
-- RELEASE, DISPATCH, REVERSAL
-- ===========================================================================
select rls_test.claims('im');
select rls_test.expect_call_error('release: PO reservations cannot be released from the generic reservations page',
  format($q$ select public.inventory_release_reservation((select id from public.stock_reservations where reference_type = 'CUSTOMER_PO' limit 1)) $q$), 'customer purchase order');
select rls_test.expect_call_error('release: PO reservations cannot be fulfilled by a generic issue',
  format($q$ select public.inventory_fulfil_reservation((select id from public.stock_reservations where reference_type = 'CUSTOMER_PO' and reservation_status = 'ACTIVE' limit 1), 1, p_idempotency_key => gen_random_uuid()) $q$), 'customer purchase order');
select rls_test.claims('viewer');
select rls_test.expect_call_error('release: Management Viewer cannot release PO reservations',
  format($q$ select public.customer_po_release(%L) $q$, rls_test.gid('po2', 'po_id')), 'not allowed');
select rls_test.claims('sales');
select rls_test.expect_call_ok('release: releasing the second PO''s basin allocation restores availability and status', 'rel2',
  format($q$ select public.customer_po_release(%L, %L, null, 'Customer agreed to wait') $q$, rls_test.gid('po2', 'po_id'), (rls_test.line(rls_test.gid('po2', 'po_id'), 3)).id));
select rls_test.ok('release: reservation marked RELEASED, reserved back to 17, PO status recalculated',
  rls_test.reserved(rls_test.id('pa')) = 17 and (rls_test.get('rel2') ->> 'status') = 'READY_FOR_ALLOCATION'
  and exists (select 1 from public.stock_reservations where reference_id = (rls_test.line(rls_test.gid('po2', 'po_id'), 3)).id and reservation_status = 'RELEASED'),
  rls_test.get('rel2')::text);
select rls_test.expect_call_ok('release: the second PO is allocated again (3 basins) before its revision arrives', 'alloc2b',
  format($q$ select public.customer_po_allocate(%L, 'EARLIEST_BATCH', null, null, true, null, gen_random_uuid()) $q$, rls_test.gid('po2', 'po_id')));

select rls_test.expect_call_error('dispatch: Sales Manager cannot record dispatch (stores permission)',
  format($q$ select public.customer_po_dispatch(%L, '[]'::jsonb, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('po1', 'po_id')), 'not allowed');
select rls_test.claims('im');
select rls_test.set('disp_items', (select jsonb_agg(jsonb_build_object('reservation_id', id, 'quantity', quantity)) from public.stock_reservations
  where reference_id = (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).id and reservation_status = 'ACTIVE'));
select rls_test.expect_call_ok('dispatch: allocated basins for line 1 dispatched (ISSUE consumes the reservations)', 'disp1',
  format($q$ select public.customer_po_dispatch(%L, %L::jsonb, 'DC-77', null, gen_random_uuid()) $q$, rls_test.gid('po1', 'po_id'), rls_test.get('disp_items')));
select rls_test.ok('dispatch: on hand 28 → 16, reserved 20 → 8, line dispatched 12, PO PARTIALLY_FULFILLED',
  rls_test.on_hand(rls_test.id('pa')) = 16 and rls_test.reserved(rls_test.id('pa')) = 8 and (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).quantity_dispatched = 12
  and (rls_test.get('disp1') ->> 'status') = 'PARTIALLY_FULFILLED', rls_test.get('disp1')::text);
select rls_test.ok('status: reservation alone never marks a PO fulfilled (closet line not dispatched)', (rls_test.po(rls_test.gid('po1', 'po_id'))).status <> 'FULFILLED');
select rls_test.expect_call_error('dispatch: generic reversal of a PO dispatch is refused',
  format($q$ select public.inventory_reverse_transaction(%L, 'Undo', gen_random_uuid()) $q$, (rls_test.get('disp1') -> 'transaction_numbers' ->> 0)), null);
select rls_test.expect_call_error('dispatch: generic reversal by id of a PO dispatch is refused',
  format($q$ select public.inventory_reverse_transaction((select id from public.inventory_transactions where transaction_number = %L and company_id = %L), 'Undo', gen_random_uuid()) $q$,
    rls_test.get('disp1') -> 'transaction_numbers' ->> 0, rls_test.id('company_a')), 'customer purchase order');
select rls_test.expect_call_ok('dispatch: authorised reversal from the PO restores stock and the line', 'rev1',
  format($q$ select public.customer_po_reverse_dispatch((select id from public.inventory_transactions where transaction_number = %L and company_id = %L), 'Wrong truck', gen_random_uuid()) $q$,
    rls_test.get('disp1') -> 'transaction_numbers' ->> 0, rls_test.id('company_a')));
select rls_test.ok('dispatch: after reversal on hand rises by the reversed quantity and the line dispatched quantity falls',
  rls_test.on_hand(rls_test.id('pa')) > 16 and (rls_test.line(rls_test.gid('po1', 'po_id'), 2)).quantity_dispatched < 12);
select rls_test.ok('ledger: balances reconcile with the ledger and reservations after all postings',
  jsonb_array_length(public.inventory_reconcile() -> 'mismatches') = 0, public.inventory_reconcile()::text);

-- ===========================================================================
-- REVISIONS, HOLD, CANCEL
-- ===========================================================================
select rls_test.claims('im');
select rls_test.expect_call_error('revision: a user without revise permission cannot import a revision',
  format($q$ select public.customer_po_import(%L::jsonb, %L::jsonb, %L::jsonb, %L, gen_random_uuid()) $q$, rls_test.get('header'), rls_test.get('lines'),
    jsonb_build_object('name', 'r2.xlsx'), rls_test.gid('po2', 'po_id')), 'not allowed');
select rls_test.claims('sales');
select rls_test.expect_call_error('revision: a revision must keep the customer and PO number',
  format($q$ select public.customer_po_import(%L::jsonb, %L::jsonb, %L::jsonb, %L, gen_random_uuid()) $q$, rls_test.get('header') || '{"customer_po_number": "PO-9999"}', rls_test.get('lines'),
    jsonb_build_object('name', 'r2.xlsx'), rls_test.gid('po2', 'po_id')), 'same customer and PO number');
select rls_test.expect_call_ok('revision: revised PO-2002 imported as revision 2 (basins 10 → 14, AMB line removed)', 'po2r2',
  format($q$ select public.customer_po_import(%L::jsonb, %L::jsonb, %L::jsonb, %L, gen_random_uuid()) $q$,
    jsonb_build_object('customer_id', rls_test.id('c1'), 'customer_po_number', 'PO-2002', 'po_date', rls_test.today()),
    jsonb_build_array(jsonb_build_object('source_row_number', 2, 'sku', 'PO-BASIN', 'quantity', 14)),
    jsonb_build_object('name', 'po2-rev2.csv', 'hash', repeat('d', 64)), rls_test.gid('po2', 'po_id')));
select rls_test.ok('revision: previous revision preserved but no longer current; new one links to it',
  (rls_test.po(rls_test.gid('po2', 'po_id'))).is_current = false and (rls_test.po(rls_test.gid('po2r2', 'po_id'))).revision = 2
  and (rls_test.po(rls_test.gid('po2r2', 'po_id'))).previous_revision_id = rls_test.gid('po2', 'po_id'));
select rls_test.ok('revision: changed and removed lines identified against the previous revision',
  (select string_agg(c ->> 'change', ',' order by c ->> 'change') from jsonb_array_elements(public.customer_po_revision_diff(rls_test.gid('po2r2', 'po_id')) -> 'changes') c) = 'CHANGED,REMOVED');
select rls_test.expect_call_error('revision: the new revision cannot be allocated while the old one still holds reservations (no double reservation)',
  format($q$ select public.customer_po_allocate(%L, 'EARLIEST_BATCH', null, null, true, null, gen_random_uuid()) $q$, rls_test.gid('po2r2', 'po_id')), 'earlier revision');
select rls_test.expect_call_error('revision: a superseded revision cannot be allocated',
  format($q$ select public.customer_po_allocate(%L, 'EARLIEST_BATCH', null, null, true, null, gen_random_uuid()) $q$, rls_test.gid('po2', 'po_id')), 'superseded');
select rls_test.call(format($q$ select public.customer_po_release(%L, null, null, 'Superseded by revision 2') $q$, rls_test.gid('po2', 'po_id')));
select rls_test.expect_call_ok('revision: after reviewing and releasing the old allocation the revision can be allocated', 'alloc2r2',
  format($q$ select public.customer_po_allocate(%L, 'EARLIEST_BATCH', null, null, true, null, gen_random_uuid()) $q$, rls_test.gid('po2r2', 'po_id')));

select rls_test.call(format($q$ select public.customer_po_action(%L, 'HOLD', 'Credit check') $q$, rls_test.gid('po2r2', 'po_id')));
select rls_test.expect_call_error('hold: a PO on hold cannot be allocated',
  format($q$ select public.customer_po_allocate(%L, 'EARLIEST_BATCH', null, null, true, null, gen_random_uuid()) $q$, rls_test.gid('po2r2', 'po_id')), 'on hold');
select rls_test.claims('viewer');
select rls_test.expect_call_error('cancel: Management Viewer cannot cancel a PO',
  format($q$ select public.customer_po_action(%L, 'CANCEL', 'x') $q$, rls_test.gid('po2r2', 'po_id')), 'not allowed');
select rls_test.claims('sales');
select rls_test.expect_call_error('cancel: cancelling requires a reason', format($q$ select public.customer_po_action(%L, 'CANCEL') $q$, rls_test.gid('po2r2', 'po_id')), 'reason');
select rls_test.set('reserved_before_cancel', to_jsonb(rls_test.reserved(rls_test.id('pa'))));
select rls_test.expect_call_ok('cancel: cancelling releases the PO''s active reservations safely', 'cancel2',
  format($q$ select public.customer_po_action(%L, 'CANCEL', 'Customer withdrew the order') $q$, rls_test.gid('po2r2', 'po_id')));
select rls_test.ok('cancel: PO CANCELLED, its reservations CANCELLED and availability restored',
  (rls_test.po(rls_test.gid('po2r2', 'po_id'))).status = 'CANCELLED' and rls_test.po_reserved(rls_test.gid('po2r2', 'po_id')) = 0
  and rls_test.reserved(rls_test.id('pa')) = (rls_test.get('reserved_before_cancel'))::numeric - (rls_test.get('cancel2') ->> 'released_quantity')::numeric);
select rls_test.ok('history: every step is in the PO history (append-only)',
  (select count(*) >= 8 from public.customer_po_events where purchase_order_id = rls_test.gid('po1', 'po_id')));
reset role;
select rls_test.expect_error('history: PO events cannot be deleted even by the owner', format($q$ delete from public.customer_po_events where purchase_order_id = %L $q$, rls_test.gid('po1', 'po_id')));
set local role authenticated;

-- ===========================================================================
-- SHORTAGES, SNAPSHOTS, DASHBOARD, CROSS-COMPANY
-- ===========================================================================
select rls_test.claims('viewer');
select rls_test.set('shortages', public.customer_po_shortages());
select rls_test.ok('shortages: closet shortage of 3 on PO-1001 with suggested actions (recommendations only)',
  (select (s ->> 'shortage')::numeric = 3 and jsonb_array_length(s -> 'suggested_actions') >= 1
   from jsonb_array_elements(rls_test.get('shortages')) s where s ->> 'sku' = 'PO-WC-01' and s ->> 'customer_po_number' = 'PO-1001')
  and not exists (select 1 from public.production_orders where company_id = rls_test.id('company_a')), rls_test.get('shortages')::text);
select rls_test.expect_call_error('shortages: Management Viewer cannot update shortage follow-up',
  format($q$ select public.customer_po_update_shortage(%L, 'IN_PROGRESS', 'HIGH', null, 'x') $q$, (rls_test.line(rls_test.gid('po1', 'po_id'), 6)).id), 'not allowed');
select rls_test.claims('sales');
select rls_test.expect_call_ok('shortages: follow-up status, priority, owner and note recorded', 'sh1',
  format($q$ select public.customer_po_update_shortage(%L, 'IN_PROGRESS', 'HIGH', %L, 'Production asked for 3 units') $q$, (rls_test.line(rls_test.gid('po1', 'po_id'), 6)).id, rls_test.id('im')));
select rls_test.expect_call_ok('snapshot: analysis refresh stores a snapshot', 'snap1', format($q$ select public.customer_po_refresh_analysis(%L) $q$, rls_test.gid('po1', 'po_id')));
select rls_test.call(format($q$ select public.customer_po_refresh_analysis(%L) $q$, rls_test.gid('po1', 'po_id')));
select rls_test.ok('snapshot: refreshing keeps earlier analyses (2 snapshots, timestamps recorded)',
  (select count(*) = 2 from public.customer_po_analysis_snapshots where purchase_order_id = rls_test.gid('po1', 'po_id'))
  and (rls_test.po(rls_test.gid('po1', 'po_id'))).last_analysis_at is not null);

select rls_test.claims('viewer');
select rls_test.set('dash', public.customer_po_dashboard(rls_test.today() - 30, rls_test.today()));
reset role;
select rls_test.ok('dashboard: PO counts match the records (current revisions only)',
  (rls_test.get('dash') ->> 'total_received')::int = (select count(*) from public.customer_purchase_orders where company_id = rls_test.id('company_a') and is_current)
  and (rls_test.get('dash') ->> 'total_received')::int = 2
  and (rls_test.get('dash') -> 'by_status')::text like '%CANCELLED%', rls_test.get('dash')::text);
select rls_test.ok('dashboard: PCS ordered and reserved units match the PO lines and reservations (no mixing with BOX/KG)',
  (select (u ->> 'ordered')::numeric = (select sum(quantity_ordered) from public.customer_purchase_order_lines l join public.customer_purchase_orders po on po.id = l.purchase_order_id
            where po.company_id = rls_test.id('company_a') and po.is_current and po.status <> 'CANCELLED' and l.line_status = 'MATCHED' and l.unit = 'PCS')
     and (u ->> 'reserved_for_pos')::numeric = rls_test.po_reserved(rls_test.gid('po1', 'po_id'))
          - (select coalesce(sum(r.quantity - r.fulfilled_quantity - r.released_quantity), 0) from public.stock_reservations r
             join public.customer_purchase_order_lines l on l.id = r.reference_id where l.purchase_order_id = rls_test.gid('po1', 'po_id') and l.unit <> 'PCS' and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED'))
   from jsonb_array_elements(rls_test.get('dash') -> 'units') u where u ->> 'unit' = 'PCS')
  and (select count(*) = 3 from jsonb_array_elements(rls_test.get('dash') -> 'units')), (rls_test.get('dash') -> 'units')::text);
set local role authenticated;

select rls_test.claims('prod');
select rls_test.expect_rows('permissions: Production Manager can read POs (for planning) — export is a separate UI permission',
  format('select * from public.customer_po_list where id = %L', rls_test.gid('po1', 'po_id')), 1);
select rls_test.claims('b_sales');
select rls_test.expect_rows('cross-company: company B sees no company A POs', 'select * from public.customer_po_list', 0);
select rls_test.expect_rows('cross-company: company B sees no company A PO lines', 'select * from public.customer_po_line_list', 0);
select rls_test.expect_rows('cross-company: company B sees no company A customers', 'select * from public.customers', 0);
select rls_test.expect_call_error('cross-company: cannot read the analysis of a company A PO', format($q$ select public.customer_po_analysis(%L) $q$, rls_test.gid('po1', 'po_id')), 'not found');
select rls_test.expect_call_error('cross-company: cannot allocate a company A PO',
  format($q$ select public.customer_po_allocate(%L, 'EARLIEST_BATCH', null, null, true, null, gen_random_uuid()) $q$, rls_test.gid('po1', 'po_id')), 'not found');
select rls_test.expect_call_error('cross-company: cannot release a company A PO', format($q$ select public.customer_po_release(%L) $q$, rls_test.gid('po1', 'po_id')), 'not found');
select rls_test.expect_call_error('cross-company: cannot import against a company A customer',
  format($q$ select public.customer_po_import(%L::jsonb, '[{"source_row_number": 2, "sku": "PO-BASIN", "quantity": 1}]'::jsonb, '{"name": "b.csv"}'::jsonb, null, gen_random_uuid()) $q$,
    jsonb_build_object('customer_id', rls_test.id('c1'), 'customer_po_number', 'B-1', 'po_date', rls_test.today())), 'not found');
select rls_test.expect_call_ok('cross-company: company B imports its own PO; the same SKU text matches only its own product', 'b_po',
  format($q$ select public.customer_po_import(%L::jsonb, '[{"source_row_number": 2, "sku": "PO-BASIN", "quantity": 1}]'::jsonb, '{"name": "b.csv"}'::jsonb, null, gen_random_uuid()) $q$,
    jsonb_build_object('customer_name', 'Acme Ltd', 'customer_po_number', 'PO-1001', 'po_date', rls_test.today())));
select rls_test.ok('cross-company: company B line matched to company B product; references are per company',
  (rls_test.line(rls_test.gid('b_po', 'po_id'), 2)).product_id = rls_test.id('b_pa') and (rls_test.get('b_po') ->> 'po_reference') = 'CPO-000001', rls_test.get('b_po')::text);

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
  raise exception 'CUSTOMER_PO_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
