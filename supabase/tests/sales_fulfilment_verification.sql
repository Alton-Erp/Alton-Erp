-- =============================================================================
-- SALES ORDERS & FULFILMENT (PHASE 7) VERIFICATION
--
-- Executable checks for customer PO -> sales order conversion (with the PO's
-- reservations), duplicate prevention, manual orders, confirmation and status
-- workflow, picking and packing without stock movement, dispatch posted exactly
-- once through the Phase 4 ledger, partial consignments, over-dispatch and
-- competing pick lists, failed-dispatch rollback, delivery events and overdue
-- deliveries, returns into quarantine with inspection and restocking,
-- cancellation (with and without dispatched goods), reports, permissions,
-- RLS and cross-company isolation, ledger reconciliation and audit history.
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction with its own companies (SOA / SOB) and ALWAYS ends
-- by raising SALES_FULFILMENT_VERIFICATION_RESULT passed=N failed=M so that
-- all test rows are rolled back. Where the passage of time matters (a lot
-- expiring, a delivery becoming overdue) the owner moves the date, as noted.
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

-- Owner-side probes (bypass RLS to check the true state)
create function rls_test.on_hand(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(on_hand), 0) from public.inventory_balances where product_id = p_product $$;
create function rls_test.reserved(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(reserved), 0) from public.inventory_balances where product_id = p_product $$;
create function rls_test.available(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(b.on_hand - b.reserved), 0) from public.inventory_balances b join public.inventory_locations l on l.id = b.location_id
  where b.product_id = p_product and l.stock_usage = 'STORAGE' $$;
create function rls_test.at_location(p_product uuid, p_location uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(on_hand), 0) from public.inventory_balances where product_id = p_product and location_id = p_location $$;
create function rls_test.so(p_id uuid) returns public.sales_orders language sql stable security definer as $$
  select * from public.sales_orders where id = p_id $$;
create function rls_test.sol(p_so uuid, p_product uuid) returns public.sales_order_lines language sql stable security definer as $$
  select * from public.sales_order_lines where sales_order_id = p_so and product_id = p_product $$;
create function rls_test.ful(p_id uuid) returns public.fulfilments language sql stable security definer as $$
  select * from public.fulfilments where id = p_id $$;
create function rls_test.fl(p_ful uuid, p_product uuid) returns public.fulfilment_lines language sql stable security definer as $$
  select * from public.fulfilment_lines where fulfilment_id = p_ful and product_id = p_product $$;
create function rls_test.res_of(p_line uuid) returns uuid language sql stable security definer as $$
  select id from public.stock_reservations where reference_type = 'SALES_ORDER_LINE' and reference_id = p_line
    and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') order by quantity - fulfilled_quantity - released_quantity desc limit 1 $$;
create function rls_test.so_reserved(p_line uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(quantity - fulfilled_quantity - released_quantity), 0) from public.stock_reservations
  where reference_type = 'SALES_ORDER_LINE' and reference_id = p_line and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') $$;
create function rls_test.po_held(p_po uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(r.quantity - r.fulfilled_quantity - r.released_quantity), 0) from public.stock_reservations r
  join public.customer_purchase_order_lines l on l.id = r.reference_id
  where l.purchase_order_id = p_po and r.reference_type = 'CUSTOMER_PO' and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') $$;
create function rls_test.so_issues(p_company uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(quantity), 0) from public.inventory_transactions where company_id = p_company and document_type = 'SALES_ORDER' and transaction_type = 'ISSUE' $$;
create function rls_test.so_issue_count(p_company uuid) returns int language sql stable security definer as $$
  select count(*)::int from public.inventory_transactions where company_id = p_company and document_type = 'SALES_ORDER' $$;
create function rls_test.events(p_so uuid) returns text[] language sql stable security definer as $$
  select array_agg(event_type order by created_at, id) from public.sales_order_events where sales_order_id = p_so $$;
create function rls_test.today() returns date language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e57400-0000-4000-8000-0000000000a1'), ('company_b', 'e7e57400-0000-4000-8000-0000000000b1'),
  ('sales', 'e7e57400-0000-4000-8000-000000000002'), ('im', 'e7e57400-0000-4000-8000-000000000003'),
  ('adm', 'e7e57400-0000-4000-8000-000000000004'), ('viewer', 'e7e57400-0000-4000-8000-000000000005'),
  ('pur', 'e7e57400-0000-4000-8000-000000000006'), ('b_sales', 'e7e57400-0000-4000-8000-000000000007'),
  ('acc', 'e7e57400-0000-4000-8000-000000000008'),
  ('pa', 'e7e57400-0000-4000-8000-0000000000c1'), ('pb', 'e7e57400-0000-4000-8000-0000000000c2'), ('pc', 'e7e57400-0000-4000-8000-0000000000c3'),
  ('b_pa', 'e7e57400-0000-4000-8000-0000000000d1'),
  ('w1', 'e7e57400-0000-4000-8000-0000000000e1'), ('w2', 'e7e57400-0000-4000-8000-0000000000e2'), ('wb', 'e7e57400-0000-4000-8000-0000000000e3'),
  ('quar', 'e7e57400-0000-4000-8000-0000000000f1'), ('rej', 'e7e57400-0000-4000-8000-0000000000f2'),
  ('c1', 'e7e57400-0000-4000-8000-0000000000aa');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code) values
  (rls_test.id('company_a'), 'SO Test A', 'SO Test A', 'SOA'), (rls_test.id('company_b'), 'SO Test B', 'SO Test B', 'SOB');
insert into auth.users (id, email) select id, key || '@so.example.invalid' from rls_test.ids where key in ('sales', 'im', 'adm', 'viewer', 'pur', 'b_sales', 'acc');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true
  where id in (rls_test.id('sales'), rls_test.id('im'), rls_test.id('adm'), rls_test.id('viewer'), rls_test.id('pur'), rls_test.id('acc'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_sales');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('sales'),   rls_test.id('company_a'), rls_test.id('role_sales_manager')),
  (rls_test.id('im'),      rls_test.id('company_a'), rls_test.id('role_inventory_manager')),
  (rls_test.id('adm'),     rls_test.id('company_a'), rls_test.id('role_admin')),
  (rls_test.id('viewer'),  rls_test.id('company_a'), rls_test.id('role_management_viewer')),
  (rls_test.id('pur'),     rls_test.id('company_a'), rls_test.id('role_purchase_manager')),
  (rls_test.id('acc'),     rls_test.id('company_a'), rls_test.id('role_accounts_manager')),
  (rls_test.id('b_sales'), rls_test.id('company_b'), rls_test.id('role_sales_manager'));

insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, track_batches, track_expiry, status) values
  (rls_test.id('pa'),   rls_test.id('company_a'), 'SO-BASIN', 'Basin',        'FINISHED_GOOD', 'IN_HOUSE',   'PCS', false, false, 'ACTIVE'),
  (rls_test.id('pb'),   rls_test.id('company_a'), 'SO-SEAL',  'Sealant',      'FINISHED_GOOD', 'OUTSOURCED', 'BOX', true,  true,  'ACTIVE'),
  (rls_test.id('pc'),   rls_test.id('company_a'), 'SO-WC',    'Water closet', 'FINISHED_GOOD', 'IN_HOUSE',   'PCS', false, false, 'ACTIVE'),
  (rls_test.id('b_pa'), rls_test.id('company_b'), 'SO-BASIN', 'B basin',      'FINISHED_GOOD', 'IN_HOUSE',   'PCS', false, false, 'ACTIVE');
insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Main', true), (rls_test.id('w2'), rls_test.id('company_a'), 'W2', 'Second', false),
  (rls_test.id('wb'), rls_test.id('company_b'), 'W1', 'B main', true);
insert into public.inventory_locations (id, company_id, warehouse_id, location_code, location_name, location_type, stock_usage) values
  (rls_test.id('quar'), rls_test.id('company_a'), rls_test.id('w1'), 'QUAR', 'Returns quarantine', 'AREA', 'QUARANTINE'),
  (rls_test.id('rej'),  rls_test.id('company_a'), rls_test.id('w1'), 'REJECT', 'Rejected bay', 'AREA', 'REJECTED');
insert into rls_test.ids (key, id)
select case warehouse_id when rls_test.id('w1') then 'g1' when rls_test.id('w2') then 'g2' else 'gb' end, id
from public.inventory_locations where location_code = 'GENERAL' and warehouse_id in (rls_test.id('w1'), rls_test.id('w2'), rls_test.id('wb'));

select rls_test.ok('RLS enabled on every public table (including Phase 7 tables)',
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity));
select rls_test.ok('clients cannot write sales order, fulfilment, delivery, return or event tables directly',
  not exists (select 1 from unnest(array['sales_orders', 'sales_order_lines', 'sales_order_events', 'fulfilments', 'fulfilment_lines', 'delivery_events',
    'customer_returns', 'customer_return_lines']) t where has_table_privilege('authenticated', 'public.' || t, 'INSERT,UPDATE,DELETE')));
select rls_test.ok('no duplicate customer, product, reservation or stock tables were created',
  not exists (select 1 from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'
    and table_name in ('sales_customers', 'sales_products', 'sales_reservations', 'sales_stock', 'order_allocations', 'dispatch_stock')));

-- Stock (Phase 4 functions)
set local role authenticated;
select rls_test.claims('im');
select rls_test.call(format($q$ select public.inventory_post_receipt(%L, %L, 50, 'IN_HOUSE', p_unit_cost => 100, p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('pa'), rls_test.id('g1')));
select rls_test.call(format($q$ select public.inventory_post_receipt(%L, %L, 10, 'IN_HOUSE', p_unit_cost => 100, p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('pa'), rls_test.id('g1')));
select rls_test.call(format($q$ select public.inventory_post_receipt(%L, %L, 10, 'OUTSOURCED', p_batch_number => 'B-1', p_expiry_date => %L, p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('pb'), rls_test.id('g1'), rls_test.today() + 30));
select rls_test.call(format($q$ select public.inventory_post_receipt(%L, %L, 3, 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('pc'), rls_test.id('g1')));
select rls_test.ok('setup: basin 60 (W1), sealant lot B-1 10 boxes, closet 3',
  rls_test.on_hand(rls_test.id('pa')) = 60 and rls_test.on_hand(rls_test.id('pb')) = 10 and rls_test.on_hand(rls_test.id('pc')) = 3);

select rls_test.claims('sales');
select rls_test.set('c1_row', rls_test.call(format($q$ insert into public.customers (company_id, customer_code, customer_name) values (%L, 'ACME', 'Acme Ltd') returning to_jsonb(customers.*) $q$,
  rls_test.id('company_a'))));
reset role;
update rls_test.ids set id = (rls_test.get('c1_row') ->> 'id')::uuid where key = 'c1';
set local role authenticated;

-- Customer PO (Phase 6): import and allocate
select rls_test.claims('sales');
select rls_test.expect_call_ok('setup: customer PO PO-7001 imported (basin 40 @1000, closet 5, sealant 4)', 'po',
  format($q$ select public.customer_po_import(%L::jsonb, %L::jsonb, '{"name": "acme-po-7001.xlsx", "rows_read": 3}'::jsonb, null, gen_random_uuid()) $q$,
    jsonb_build_object('customer_id', rls_test.id('c1'), 'customer_po_number', 'PO-7001', 'po_date', rls_test.today() - 1, 'required_delivery_date', rls_test.today() + 5, 'currency', 'INR'),
    jsonb_build_array(
      jsonb_build_object('source_row_number', 2, 'sku', 'SO-BASIN', 'quantity', 40, 'unit_price', 1000),
      jsonb_build_object('source_row_number', 3, 'sku', 'SO-WC', 'quantity', 5),
      jsonb_build_object('source_row_number', 4, 'sku', 'SO-SEAL', 'quantity', 4))));
select rls_test.expect_call_ok('setup: PO allocated through Phase 6 (basin 40, closet 3 of 5, sealant 4)', 'po_alloc',
  format($q$ select public.customer_po_allocate(%L, 'IN_HOUSE_FIRST', null, null, true, null, gen_random_uuid()) $q$, rls_test.gid('po', 'po_id')));
select rls_test.ok('setup: the PO holds 47 reserved units', rls_test.po_held(rls_test.gid('po', 'po_id')) = 47 and rls_test.reserved(rls_test.id('pa')) = 40,
  rls_test.po_held(rls_test.gid('po', 'po_id'))::text);

-- ===========================================================================
-- 1-3. CONVERSION, DUPLICATES, PARTIAL ALLOCATION
-- ===========================================================================
select rls_test.claims('viewer');
select rls_test.expect_call_error('convert: Management Viewer cannot create sales orders',
  format($q$ select public.sales_order_create_from_po(%L, '{}'::jsonb, null, false, false, gen_random_uuid()) $q$, rls_test.gid('po', 'po_id')), 'sales_orders.create');
select rls_test.claims('sales');
select rls_test.set('preview', rls_test.call(format($q$ select public.sales_order_po_preview(%L) $q$, rls_test.gid('po', 'po_id'))));
select rls_test.ok('convert: preview verifies identity, has no blockers and shows convertible quantities and the PO reservations',
  rls_test.get('preview') -> 'po' ->> 'customer_po_number' = 'PO-7001' and jsonb_array_length(rls_test.get('preview') -> 'blockers') = 0
  and (select sum((l ->> 'convertible')::numeric) from jsonb_array_elements(rls_test.get('preview') -> 'lines') l) = 49
  and (select sum((l ->> 'po_reserved')::numeric) from jsonb_array_elements(rls_test.get('preview') -> 'lines') l) = 47, rls_test.get('preview')::text);
select rls_test.set('conv_key', to_jsonb(gen_random_uuid()));
select rls_test.expect_call_ok('convert: Sales Manager converts the PO into a sales order (pending confirmation)', 'so1',
  format($q$ select public.sales_order_create_from_po(%L, '{"shipping_address": "Plot 4, Industrial Area", "priority": "HIGH"}'::jsonb, null, false, false, %L) $q$,
    rls_test.gid('po', 'po_id'), rls_test.get('conv_key') #>> '{}'));
select rls_test.ok('convert: SO created with 3 lines, status pending confirmation, linked to the PO and its file',
  (rls_test.so(rls_test.gid('so1', 'sales_order_id'))).order_status = 'PENDING_CONFIRMATION'
  and (rls_test.so(rls_test.gid('so1', 'sales_order_id'))).customer_purchase_order_id = rls_test.gid('po', 'po_id')
  and (rls_test.so(rls_test.gid('so1', 'sales_order_id'))).source_filename = 'acme-po-7001.xlsx'
  and (rls_test.so(rls_test.gid('so1', 'sales_order_id'))).customer_name_snapshot = 'Acme Ltd'
  and (rls_test.get('so1') ->> 'lines')::int = 3, rls_test.get('so1')::text);
select rls_test.ok('convert: PO price kept on the line separately from the product master',
  (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('pa'))).unit_price_snapshot = 1000);
select rls_test.ok('convert: all 47 reserved units moved to the sales order lines; nothing reserved twice',
  (rls_test.get('so1') ->> 'transferred_reserved')::numeric = 47 and rls_test.po_held(rls_test.gid('po', 'po_id')) = 0
  and rls_test.so_reserved((rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('pa'))).id) = 40
  and rls_test.reserved(rls_test.id('pa')) = 40 and rls_test.on_hand(rls_test.id('pa')) = 60);
select rls_test.expect_call_ok('convert: a retried request (same key) returns the same order instead of creating another', 'so1_retry',
  format($q$ select public.sales_order_create_from_po(%L, '{}'::jsonb, null, false, false, %L) $q$, rls_test.gid('po', 'po_id'), rls_test.get('conv_key') #>> '{}'));
select rls_test.ok('convert: retry reported as duplicate with the same SO number',
  (rls_test.get('so1_retry') ->> 'duplicate')::boolean and rls_test.get('so1_retry') ->> 'sales_order_number' = rls_test.get('so1') ->> 'sales_order_number');
select rls_test.expect_call_error('convert: converting the same PO again is refused (duplicate order)',
  format($q$ select public.sales_order_create_from_po(%L, '{}'::jsonb, null, false, false, gen_random_uuid()) $q$, rls_test.gid('po', 'po_id')), 'already has sales order');
select rls_test.expect_call_error('convert: an explicit split order cannot exceed the unconverted quantity',
  format($q$ select public.sales_order_create_from_po(%L, '{}'::jsonb, null, true, false, gen_random_uuid()) $q$, rls_test.gid('po', 'po_id')), 'Nothing to convert');
select rls_test.ok('convert: exactly one sales order exists for the PO', (select count(*) from public.sales_orders where customer_purchase_order_id = rls_test.gid('po', 'po_id')) = 1);

-- Phase 6 guards (2 more closets arrive at W2, so the PO module would find stock to reserve)
select rls_test.claims('im');
select rls_test.call(format($q$ select public.inventory_post_receipt(%L, %L, 2, 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('pc'), rls_test.id('g2')));
select rls_test.claims('sales');
select rls_test.expect_call_error('PO guard: the PO module can no longer allocate the converted PO (even with stock available)',
  format($q$ select public.customer_po_allocate(%L, 'IN_HOUSE_FIRST', null, null, true, null, gen_random_uuid()) $q$, rls_test.gid('po', 'po_id')), 'sales order');
select rls_test.ok('PO guard: the refused PO allocation reserved nothing', rls_test.reserved(rls_test.id('pc')) = 3 and rls_test.po_held(rls_test.gid('po', 'po_id')) = 0);
select rls_test.expect_call_error('PO guard: the PO cannot be cancelled while it has a sales order',
  format($q$ select public.customer_po_action(%L, 'CANCEL', 'customer changed mind') $q$, rls_test.gid('po', 'po_id')), 'sales order');
select rls_test.expect_call_error('PO guard: a converted PO line cannot be excluded in the PO module',
  format($q$ select public.customer_po_line_action((select id from public.customer_purchase_order_lines where purchase_order_id = %L and line_no = 1), 'EXCLUDE', p_note => 'x') $q$,
    rls_test.gid('po', 'po_id')));
reset role;
select rls_test.expect_error('PO guard: the database refuses changing the product or quantity of a converted PO line',
  format($q$ update public.customer_purchase_order_lines set quantity_ordered = 1 where purchase_order_id = %L and line_no = 1 $q$, rls_test.gid('po', 'po_id')));
set local role authenticated;
select rls_test.claims('sales');
select rls_test.ok('PO status: Phase 6 analysis still counts the stock reserved for the sales order (allocated 40 on the basin line)',
  private.po_line_open_reserved((select id from public.customer_purchase_order_lines where purchase_order_id = rls_test.gid('po', 'po_id') and line_no = 1)) = 40);

-- Manual order
select rls_test.claims('viewer');
select rls_test.expect_call_error('manual: Management Viewer cannot create manual orders',
  format($q$ select public.sales_order_create_manual(%L::jsonb, %L::jsonb, false, gen_random_uuid()) $q$,
    jsonb_build_object('customer_id', rls_test.id('c1')), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('pa'), 'quantity', 5))), 'sales_orders.create');
select rls_test.claims('sales');
select rls_test.expect_call_error('manual: an unknown customer is refused',
  format($q$ select public.sales_order_create_manual(%L::jsonb, %L::jsonb, false, gen_random_uuid()) $q$,
    jsonb_build_object('customer_id', gen_random_uuid()), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('pa'), 'quantity', 5))), 'customer');
select rls_test.expect_call_error('manual: a product of another company is refused',
  format($q$ select public.sales_order_create_manual(%L::jsonb, %L::jsonb, false, gen_random_uuid()) $q$,
    jsonb_build_object('customer_id', rls_test.id('c1')), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('b_pa'), 'quantity', 5))), 'active product');
select rls_test.expect_call_error('manual: an imported customer PO number cannot be re-entered manually (duplicate)',
  format($q$ select public.sales_order_create_manual(%L::jsonb, %L::jsonb, false, gen_random_uuid()) $q$,
    jsonb_build_object('customer_id', rls_test.id('c1'), 'customer_po_number', 'po-7001'), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('pa'), 'quantity', 5))), 'imported');
select rls_test.expect_call_ok('manual: Sales Manager creates a manual order (basin 5)', 'so2',
  format($q$ select public.sales_order_create_manual(%L::jsonb, %L::jsonb, false, gen_random_uuid()) $q$,
    jsonb_build_object('customer_id', rls_test.id('c1'), 'customer_po_number', 'TEL-55', 'warehouse_id', rls_test.id('w1')),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('pa'), 'quantity', 5, 'unit_price', 990))));
select rls_test.expect_call_error('manual: the same customer PO number cannot be entered twice',
  format($q$ select public.sales_order_create_manual(%L::jsonb, %L::jsonb, false, gen_random_uuid()) $q$,
    jsonb_build_object('customer_id', rls_test.id('c1'), 'customer_po_number', 'TEL-55'), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('pa'), 'quantity', 1))), 'already exists');

-- ===========================================================================
-- 4. STATUS WORKFLOW
-- ===========================================================================
select rls_test.claims('im');
select rls_test.expect_call_error('workflow: a pick list cannot be created before the order is confirmed',
  format($q$ select public.fulfilment_create(%L, %L, null, null, null, gen_random_uuid()) $q$, rls_test.gid('so1', 'sales_order_id'), rls_test.id('w1')), 'awaiting confirmation');
select rls_test.expect_call_error('workflow: Inventory Manager cannot confirm orders',
  format($q$ select public.sales_order_confirm(%L) $q$, rls_test.gid('so1', 'sales_order_id')), 'sales_orders.confirm');
select rls_test.claims('sales');
select rls_test.expect_call_ok('workflow: Sales Manager confirms the converted order', 'so1_conf', format($q$ select public.sales_order_confirm(%L) $q$, rls_test.gid('so1', 'sales_order_id')));
select rls_test.ok('workflow: confirmed order with closet 3 of 5 reserved is partially allocated (not ready, not fulfilled)',
  rls_test.get('so1_conf') ->> 'status' = 'PARTIALLY_ALLOCATED', rls_test.get('so1_conf')::text);
select rls_test.expect_call_error('workflow: confirming twice is refused', format($q$ select public.sales_order_confirm(%L) $q$, rls_test.gid('so1', 'sales_order_id')), 'already');
select rls_test.expect_call_error('workflow: there is no RPC to set an arbitrary status (direct update denied)',
  format($q$ update public.sales_orders set order_status = 'FULFILLED' where id = %L $q$, rls_test.gid('so1', 'sales_order_id')));
select rls_test.expect_call_ok('workflow: hold', 'hold', format($q$ select public.sales_order_action(%L, 'HOLD', 'credit check') $q$, rls_test.gid('so1', 'sales_order_id')));
select rls_test.claims('im');
select rls_test.expect_call_error('workflow: no pick list while the order is on hold',
  format($q$ select public.fulfilment_create(%L, %L, null, null, null, gen_random_uuid()) $q$, rls_test.gid('so1', 'sales_order_id'), rls_test.id('w1')), 'on hold');
select rls_test.claims('sales');
select rls_test.expect_call_ok('workflow: resume returns to the status computed from the records', 'resume',
  format($q$ select public.sales_order_action(%L, 'RESUME', null) $q$, rls_test.gid('so1', 'sales_order_id')));
select rls_test.ok('workflow: resumed as partially allocated', rls_test.get('resume') ->> 'status' = 'PARTIALLY_ALLOCATED', rls_test.get('resume')::text);

-- ===========================================================================
-- 5-6. PICKING AND PACKING (no stock movement)
-- ===========================================================================
reset role;
insert into rls_test.ids values
  ('l_basin', (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('pa'))).id),
  ('l_wc', (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('pc'))).id),
  ('l_seal', (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('pb'))).id);
insert into rls_test.ids values ('r_basin', rls_test.res_of(rls_test.id('l_basin'))), ('r_wc', rls_test.res_of(rls_test.id('l_wc'))), ('r_seal', rls_test.res_of(rls_test.id('l_seal')));
set local role authenticated;

select rls_test.claims('sales');
select rls_test.expect_call_error('picking: Sales Manager cannot create pick lists', format($q$ select public.fulfilment_create(%L, %L, null, null, null, gen_random_uuid()) $q$,
  rls_test.gid('so1', 'sales_order_id'), rls_test.id('w1')), 'fulfilment.pick');
select rls_test.claims('im');
select rls_test.expect_call_error('picking: a pick list cannot take more than the reservation holds',
  format($q$ select public.fulfilment_create(%L, %L, %L::jsonb, null, null, gen_random_uuid()) $q$, rls_test.gid('so1', 'sales_order_id'), rls_test.id('w1'),
    jsonb_build_array(jsonb_build_object('reservation_id', rls_test.id('r_basin'), 'quantity', 41))), 'pick between 0 and 40');
select rls_test.expect_call_ok('picking: pick list F1 (basin 25, closet 3, sealant 4)', 'f1',
  format($q$ select public.fulfilment_create(%L, %L, %L::jsonb, null, 'first consignment', gen_random_uuid()) $q$, rls_test.gid('so1', 'sales_order_id'), rls_test.id('w1'),
    jsonb_build_array(jsonb_build_object('reservation_id', rls_test.id('r_basin'), 'quantity', 25), jsonb_build_object('reservation_id', rls_test.id('r_wc'), 'quantity', 3),
      jsonb_build_object('reservation_id', rls_test.id('r_seal'), 'quantity', 4))));
select rls_test.ok('picking: order is in fulfilment; stock unchanged', (rls_test.so(rls_test.gid('so1', 'sales_order_id'))).order_status = 'IN_FULFILMENT'
  and rls_test.on_hand(rls_test.id('pa')) = 60 and rls_test.reserved(rls_test.id('pa')) = 40);
select rls_test.expect_call_error('picking: another pick list cannot take the same closet units again',
  format($q$ select public.fulfilment_create(%L, %L, %L::jsonb, null, null, gen_random_uuid()) $q$, rls_test.gid('so1', 'sales_order_id'), rls_test.id('w1'),
    jsonb_build_array(jsonb_build_object('reservation_id', rls_test.id('r_wc'), 'quantity', 1))), 'pick between 0 and 0');

select rls_test.expect_call_error('picking: picked quantity cannot exceed the pick list',
  format($q$ select public.fulfilment_pick(%L, %L::jsonb, false) $q$, rls_test.gid('f1', 'fulfilment_id'),
    jsonb_build_array(jsonb_build_object('line_id', (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pa'))).id, 'quantity_picked', 26))), 'between 0 and 25');
-- Time passes: the sealant lot expires (owner moves the date).
reset role;
update public.inventory_batches set expiry_date = rls_test.today() - 1 where product_id = rls_test.id('pb') and batch_number = 'B-1';
set local role authenticated;
select rls_test.claims('im');
select rls_test.expect_call_error('picking: an expired lot is flagged and cannot be picked',
  format($q$ select public.fulfilment_pick(%L, %L::jsonb, false) $q$, rls_test.gid('f1', 'fulfilment_id'),
    jsonb_build_array(jsonb_build_object('line_id', (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pb'))).id, 'quantity_picked', 4))), 'expired');
select rls_test.expect_rows('picking: the pick list view shows why the lot is ineligible',
  format($q$ select 1 from public.fulfilment_line_list where fulfilment_id = %L and stock_problem ilike '%%expired%%' $q$, rls_test.gid('f1', 'fulfilment_id')), 1);
select rls_test.expect_call_ok('picking: basin 25, closet 2 (short) and sealant 0 recorded', 'pick1',
  format($q$ select public.fulfilment_pick(%L, %L::jsonb, false) $q$, rls_test.gid('f1', 'fulfilment_id'),
    jsonb_build_array(jsonb_build_object('line_id', (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pa'))).id, 'quantity_picked', 25),
      jsonb_build_object('line_id', (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pc'))).id, 'quantity_picked', 2),
      jsonb_build_object('line_id', (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pb'))).id, 'quantity_picked', 0))));
select rls_test.expect_call_error('picking: short-picked lines need an exception before picking can be completed',
  format($q$ select public.fulfilment_pick(%L, '[]'::jsonb, true) $q$, rls_test.gid('f1', 'fulfilment_id')), 'pick exception');
select rls_test.expect_call_ok('picking: exceptions recorded and picking completed', 'pick1_done',
  format($q$ select public.fulfilment_pick(%L, %L::jsonb, true) $q$, rls_test.gid('f1', 'fulfilment_id'),
    jsonb_build_array(jsonb_build_object('line_id', (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pc'))).id, 'quantity_picked', 2, 'exception', 'one unit cracked on the shelf'),
      jsonb_build_object('line_id', (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pb'))).id, 'quantity_picked', 0, 'exception', 'lot expired'))));
select rls_test.ok('picking: recorded with user and time; picking did NOT reduce stock or reservations',
  (rls_test.ful(rls_test.gid('f1', 'fulfilment_id'))).fulfilment_status = 'PICKED'
  and (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pa'))).picked_by = rls_test.id('im')
  and rls_test.on_hand(rls_test.id('pa')) = 60 and rls_test.reserved(rls_test.id('pa')) = 40 and rls_test.so_issue_count(rls_test.id('company_a')) = 0);

select rls_test.expect_call_error('packing: packed plus damaged cannot exceed picked',
  format($q$ select public.fulfilment_pack(%L, %L::jsonb, null, false) $q$, rls_test.gid('f1', 'fulfilment_id'),
    jsonb_build_array(jsonb_build_object('line_id', (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pa'))).id, 'quantity_packed', 25, 'quantity_damaged', 1, 'exception', 'x'))), 'cannot exceed');
select rls_test.expect_call_error('packing: damaged items need a description',
  format($q$ select public.fulfilment_pack(%L, %L::jsonb, null, false) $q$, rls_test.gid('f1', 'fulfilment_id'),
    jsonb_build_array(jsonb_build_object('line_id', (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pa'))).id, 'quantity_packed', 24, 'quantity_damaged', 1))), 'describe');
select rls_test.expect_call_ok('packing: basin 24 packed + 1 damaged, closet 2 packed; completed', 'pack1',
  format($q$ select public.fulfilment_pack(%L, %L::jsonb, 'wrapped in bubble film', true) $q$, rls_test.gid('f1', 'fulfilment_id'),
    jsonb_build_array(jsonb_build_object('line_id', (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pa'))).id, 'quantity_packed', 24, 'quantity_damaged', 1, 'exception', 'chipped rim'),
      jsonb_build_object('line_id', (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pc'))).id, 'quantity_packed', 2))));
select rls_test.expect_call_ok('packing: reopen packing with a reason, then complete again', 'reopen',
  format($q$ select public.fulfilment_action(%L, 'REOPEN_PACKING', 'recount cartons') $q$, rls_test.gid('f1', 'fulfilment_id')));
select rls_test.expect_call_ok('packing: completed again', 'pack1b', format($q$ select public.fulfilment_pack(%L, '[]'::jsonb, null, true) $q$, rls_test.gid('f1', 'fulfilment_id')));
select rls_test.expect_call_error('dispatch: a packed fulfilment must be marked ready before dispatch',
  format($q$ select public.fulfilment_dispatch(%L, '{}'::jsonb, gen_random_uuid()) $q$, rls_test.gid('f1', 'fulfilment_id')), 'ready for dispatch');
select rls_test.expect_call_ok('packing: marked ready for dispatch', 'ready1', format($q$ select public.fulfilment_action(%L, 'READY') $q$, rls_test.gid('f1', 'fulfilment_id')));
select rls_test.ok('packing: still no stock movement after packing', rls_test.on_hand(rls_test.id('pa')) = 60 and rls_test.so_issue_count(rls_test.id('company_a')) = 0);

-- ===========================================================================
-- 7, 9, 10, 11. DISPATCH: exactly once, policy, rollback
-- ===========================================================================
select rls_test.claims('sales');
select rls_test.expect_call_error('dispatch: Sales Manager cannot post dispatches', format($q$ select public.fulfilment_dispatch(%L, '{}'::jsonb, gen_random_uuid()) $q$,
  rls_test.gid('f1', 'fulfilment_id')), 'fulfilment.dispatch');
reset role;
insert into public.company_settings (company_id, setting_key, setting_value) values (rls_test.id('company_a'), 'fulfilment.dispatch_required_fields', '["vehicle_number"]');
set local role authenticated;
select rls_test.claims('im');
select rls_test.expect_call_error('dispatch: company policy fields are required (vehicle number); nothing posted',
  format($q$ select public.fulfilment_dispatch(%L, '{"carrier_name": "Fast Freight"}'::jsonb, gen_random_uuid()) $q$, rls_test.gid('f1', 'fulfilment_id')), 'vehicle number');
select rls_test.ok('dispatch: failed validation posted nothing', rls_test.on_hand(rls_test.id('pa')) = 60 and rls_test.so_issue_count(rls_test.id('company_a')) = 0);
select rls_test.set('disp_key', to_jsonb(gen_random_uuid()));
select rls_test.expect_call_ok('dispatch: F1 dispatched with transport details', 'disp1',
  format($q$ select public.fulfilment_dispatch(%L, '{"carrier_name": "Fast Freight", "transport_mode": "ROAD", "vehicle_number": "mh12ab1234", "lr_number": "LR-9", "tracking_number": "TRK-1001"}'::jsonb, %L) $q$,
    rls_test.gid('f1', 'fulfilment_id'), rls_test.get('disp_key') #>> '{}'));
select rls_test.ok('dispatch: two ISSUE postings (basin 24 + closet 2) consumed the reservations; on hand 60 -> 36, reserved 40 -> 16',
  jsonb_array_length(rls_test.get('disp1') -> 'transaction_numbers') = 2 and rls_test.on_hand(rls_test.id('pa')) = 36 and rls_test.reserved(rls_test.id('pa')) = 16
  and rls_test.on_hand(rls_test.id('pc')) = 3 and rls_test.so_issues(rls_test.id('company_a')) = 26, rls_test.get('disp1')::text);
select rls_test.ok('dispatch: fulfilment, order and PO lines updated together; vehicle upper-cased; delivery history started',
  (rls_test.ful(rls_test.gid('f1', 'fulfilment_id'))).fulfilment_status = 'DISPATCHED' and (rls_test.ful(rls_test.gid('f1', 'fulfilment_id'))).vehicle_number = 'MH12AB1234'
  and (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('pa'))).quantity_dispatched = 24
  and (select quantity_dispatched from public.customer_purchase_order_lines where purchase_order_id = rls_test.gid('po', 'po_id') and line_no = 1) = 24
  and exists (select 1 from public.delivery_events where fulfilment_id = rls_test.gid('f1', 'fulfilment_id') and event_type = 'DISPATCHED' and source = 'SYSTEM')
  and (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pa'))).issue_transaction_id is not null);
select rls_test.ok('dispatch: order partially fulfilled / partially dispatched', (rls_test.so(rls_test.gid('so1', 'sales_order_id'))).order_status = 'PARTIALLY_FULFILLED'
  and (rls_test.so(rls_test.gid('so1', 'sales_order_id'))).fulfilment_status = 'PARTIALLY_DISPATCHED');
select rls_test.expect_call_ok('dispatch: a retried request (same key) returns the first result', 'disp1_retry',
  format($q$ select public.fulfilment_dispatch(%L, '{}'::jsonb, %L) $q$, rls_test.gid('f1', 'fulfilment_id'), rls_test.get('disp_key') #>> '{}'));
select rls_test.ok('dispatch: the retry deducted nothing (exactly-once)', (rls_test.get('disp1_retry') ->> 'duplicate')::boolean and rls_test.on_hand(rls_test.id('pa')) = 36
  and rls_test.so_issue_count(rls_test.id('company_a')) = 2);
select rls_test.expect_call_error('dispatch: a second dispatch of the same fulfilment (new request) is refused',
  format($q$ select public.fulfilment_dispatch(%L, '{"vehicle_number": "X"}'::jsonb, gen_random_uuid()) $q$, rls_test.gid('f1', 'fulfilment_id')), 'ready for dispatch');
select rls_test.expect_call_error('dispatch: the generic stock reversal refuses sales order dispatches',
  format($q$ select public.inventory_reverse_transaction((select issue_transaction_id from public.fulfilment_lines where id = %L), 'oops', gen_random_uuid()) $q$,
    (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pa'))).id), 'sales order');
select rls_test.expect_call_error('reservations: the generic reservation release refuses sales order reservations',
  format($q$ select public.inventory_release_reservation(%L) $q$, rls_test.id('r_basin')), 'sales order');
select rls_test.expect_call_error('reservations: generic fulfil cannot issue sales order reservations',
  format($q$ select public.inventory_fulfil_reservation(%L, 1, null, null, gen_random_uuid()) $q$, rls_test.id('r_basin')), 'sales order');

-- ===========================================================================
-- 8, 10. PARTIAL CONSIGNMENTS AND COMPETING PICK LISTS
-- ===========================================================================
select rls_test.expect_call_ok('consignments: pick list F2 (basin 10, closet 1)', 'f2',
  format($q$ select public.fulfilment_create(%L, %L, %L::jsonb, null, null, gen_random_uuid()) $q$, rls_test.gid('so1', 'sales_order_id'), rls_test.id('w1'),
    jsonb_build_array(jsonb_build_object('reservation_id', rls_test.id('r_basin'), 'quantity', 10), jsonb_build_object('reservation_id', rls_test.id('r_wc'), 'quantity', 1))));
select rls_test.expect_call_ok('consignments: pick list F3 takes the remaining 6 basins of the same reservation', 'f3',
  format($q$ select public.fulfilment_create(%L, %L, %L::jsonb, null, null, gen_random_uuid()) $q$, rls_test.gid('so1', 'sales_order_id'), rls_test.id('w1'),
    jsonb_build_array(jsonb_build_object('reservation_id', rls_test.id('r_basin'), 'quantity', 6))));
select rls_test.expect_call_error('competing: a further pick list cannot hold units already on F2/F3 (no double allocation)',
  format($q$ select public.fulfilment_create(%L, %L, %L::jsonb, null, null, gen_random_uuid()) $q$, rls_test.gid('so1', 'sales_order_id'), rls_test.id('w1'),
    jsonb_build_array(jsonb_build_object('reservation_id', rls_test.id('r_basin'), 'quantity', 1))), 'pick between 0 and 0');
select rls_test.expect_call_error('competing: an automatic pick list finds nothing free (expired sealant skipped)',
  format($q$ select public.fulfilment_create(%L, %L, null, null, null, gen_random_uuid()) $q$, rls_test.gid('so1', 'sales_order_id'), rls_test.id('w1')), 'free to pick');
select rls_test.claims('sales');
select rls_test.expect_call_error('over-dispatch: quantity already on open pick lists cannot be cancelled from the line',
  format($q$ select public.sales_order_line_update(%L, null, null, 1, 'customer asked') $q$, rls_test.id('l_basin')), 'reduce by between 0 and 0');
reset role;
select rls_test.expect_error('over-dispatch: the database rejects dispatched + cancelled above the ordered quantity (constraint)',
  format($q$ update public.sales_order_lines set quantity_dispatched = 41 where id = %L $q$, rls_test.id('l_basin')));
set local role authenticated;
select rls_test.claims('im');
select rls_test.call(format($q$ select public.fulfilment_pick(%L, %L::jsonb, true) $q$, rls_test.gid('f2', 'fulfilment_id'),
  jsonb_build_array(jsonb_build_object('line_id', (rls_test.fl(rls_test.gid('f2', 'fulfilment_id'), rls_test.id('pa'))).id, 'quantity_picked', 10),
    jsonb_build_object('line_id', (rls_test.fl(rls_test.gid('f2', 'fulfilment_id'), rls_test.id('pc'))).id, 'quantity_picked', 1))));
select rls_test.call(format($q$ select public.fulfilment_pack(%L, %L::jsonb, null, true) $q$, rls_test.gid('f2', 'fulfilment_id'),
  jsonb_build_array(jsonb_build_object('line_id', (rls_test.fl(rls_test.gid('f2', 'fulfilment_id'), rls_test.id('pa'))).id, 'quantity_packed', 10),
    jsonb_build_object('line_id', (rls_test.fl(rls_test.gid('f2', 'fulfilment_id'), rls_test.id('pc'))).id, 'quantity_packed', 1))));
select rls_test.expect_call_ok('consignments: F2 ready', 'ready2', format($q$ select public.fulfilment_action(%L, 'READY') $q$, rls_test.gid('f2', 'fulfilment_id')));
-- The closet reservation stops being valid after F2 was marked ready (owner simulates an expired reservation).
reset role;
update public.stock_reservations set reservation_status = 'EXPIRED' where id = rls_test.id('r_wc');
set local role authenticated;
select rls_test.claims('im');
select rls_test.expect_call_error('rollback: dispatch fails on the second line after the first was posted',
  format($q$ select public.fulfilment_dispatch(%L, '{"vehicle_number": "MH12AB1234"}'::jsonb, gen_random_uuid()) $q$, rls_test.gid('f2', 'fulfilment_id')), 'Nothing was dispatched');
select rls_test.ok('rollback: nothing from the failed dispatch remains (stock, ledger, order, fulfilment)',
  rls_test.on_hand(rls_test.id('pa')) = 36 and rls_test.so_issue_count(rls_test.id('company_a')) = 2
  and (rls_test.ful(rls_test.gid('f2', 'fulfilment_id'))).fulfilment_status = 'READY_FOR_DISPATCH'
  and (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('pa'))).quantity_dispatched = 24);
reset role;
update public.stock_reservations set reservation_status = 'PARTIALLY_FULFILLED' where id = rls_test.id('r_wc');
set local role authenticated;
select rls_test.claims('im');
select rls_test.expect_call_ok('consignments: F2 dispatched', 'disp2',
  format($q$ select public.fulfilment_dispatch(%L, %L::jsonb, gen_random_uuid()) $q$, rls_test.gid('f2', 'fulfilment_id'),
    jsonb_build_object('vehicle_number', 'MH12AB1234', 'carrier_name', 'Fast Freight', 'expected_delivery_date', rls_test.today() + 2)));
select rls_test.call(format($q$ select public.fulfilment_pick(%L, %L::jsonb, true) $q$, rls_test.gid('f3', 'fulfilment_id'),
  jsonb_build_array(jsonb_build_object('line_id', (rls_test.fl(rls_test.gid('f3', 'fulfilment_id'), rls_test.id('pa'))).id, 'quantity_picked', 6))));
select rls_test.call(format($q$ select public.fulfilment_pack(%L, %L::jsonb, null, true) $q$, rls_test.gid('f3', 'fulfilment_id'),
  jsonb_build_array(jsonb_build_object('line_id', (rls_test.fl(rls_test.gid('f3', 'fulfilment_id'), rls_test.id('pa'))).id, 'quantity_packed', 6))));
select rls_test.call(format($q$ select public.fulfilment_action(%L, 'READY') $q$, rls_test.gid('f3', 'fulfilment_id')));
select rls_test.claims('im');
select rls_test.expect_call_error('delivery: no delivery events before the dispatch is posted',
  format($q$ select public.fulfilment_record_delivery(%L, 'IN_TRANSIT', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('f3', 'fulfilment_id')), 'after dispatch');
select rls_test.expect_call_ok('consignments: F3 dispatched', 'disp3',
  format($q$ select public.fulfilment_dispatch(%L, '{"vehicle_number": "KA01CD9876", "carrier_name": "Blue Dart Couriers"}'::jsonb, gen_random_uuid()) $q$, rls_test.gid('f3', 'fulfilment_id')));
select rls_test.ok('consignments: three consignments total basin 40 = ordered; closet 3; ledger issues 43 = order lines = fulfilment lines = PO lines',
  (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('pa'))).quantity_dispatched = 40
  and (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('pc'))).quantity_dispatched = 3
  and rls_test.so_issues(rls_test.id('company_a')) = 43
  and (select sum(quantity_dispatched) from public.sales_order_lines where sales_order_id = rls_test.gid('so1', 'sales_order_id')) = 43
  and (select sum(fl.quantity_dispatched) from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id where f.sales_order_id = rls_test.gid('so1', 'sales_order_id')) = 43
  and (select sum(quantity_dispatched) from public.customer_purchase_order_lines where purchase_order_id = rls_test.gid('po', 'po_id')) = 43
  and rls_test.on_hand(rls_test.id('pa')) = 20 and rls_test.reserved(rls_test.id('pa')) = 0);
select rls_test.ok('consignments: basin reservation fully consumed (FULFILLED); never more than it held',
  (select reservation_status = 'FULFILLED' and fulfilled_quantity = quantity from public.stock_reservations where id = rls_test.id('r_basin')));

-- ===========================================================================
-- 14, 15. DELIVERY TRACKING
-- ===========================================================================
select rls_test.claims('viewer');
select rls_test.expect_call_error('delivery: Management Viewer cannot record delivery events',
  format($q$ select public.fulfilment_record_delivery(%L, 'IN_TRANSIT', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('f1', 'fulfilment_id')), 'fulfilment_delivery.update');
select rls_test.claims('sales');
select rls_test.expect_call_ok('delivery: in transit', 'ev1',
  format($q$ select public.fulfilment_record_delivery(%L, 'IN_TRANSIT', null, 'Pune hub', 'Left hub', 'TRK-1001', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('f1', 'fulfilment_id')));
select rls_test.expect_call_error('delivery: delivered quantity cannot exceed the dispatched quantity',
  format($q$ select public.fulfilment_record_delivery(%L, 'PARTIALLY_DELIVERED', p_lines => %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('f1', 'fulfilment_id'),
    jsonb_build_array(jsonb_build_object('line_id', (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pa'))).id, 'quantity', 25))), 'cannot exceed');
select rls_test.expect_call_error('delivery: a partial delivery needs quantities',
  format($q$ select public.fulfilment_record_delivery(%L, 'PARTIALLY_DELIVERED', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('f1', 'fulfilment_id')), 'quantity');
select rls_test.expect_call_ok('delivery: 20 basins delivered first', 'ev2',
  format($q$ select public.fulfilment_record_delivery(%L, 'PARTIALLY_DELIVERED', p_lines => %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('f1', 'fulfilment_id'),
    jsonb_build_array(jsonb_build_object('line_id', (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pa'))).id, 'quantity', 20))));
select rls_test.ok('delivery: partially delivered; delivery did not change stock', (rls_test.ful(rls_test.gid('f1', 'fulfilment_id'))).fulfilment_status = 'PARTIALLY_DELIVERED'
  and rls_test.on_hand(rls_test.id('pa')) = 20 and (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('pa'))).quantity_delivered = 20);
select rls_test.expect_call_ok('delivery: rest delivered (all remaining quantities)', 'ev3',
  format($q$ select public.fulfilment_record_delivery(%L, 'DELIVERED', null, 'Customer site', 'Signed by store keeper', 'POD-77', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('f1', 'fulfilment_id')));
select rls_test.ok('delivery: F1 delivered with a delivery date; expected vs actual on time',
  (rls_test.ful(rls_test.gid('f1', 'fulfilment_id'))).fulfilment_status = 'DELIVERED' and (rls_test.ful(rls_test.gid('f1', 'fulfilment_id'))).delivered_at is not null
  and (select delivery_days_late <= 0 from public.fulfilment_list where id = rls_test.gid('f1', 'fulfilment_id')));
select rls_test.expect_call_error('delivery: a delivered consignment accepts no further events',
  format($q$ select public.fulfilment_record_delivery(%L, 'IN_TRANSIT', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('f1', 'fulfilment_id')), 'already delivered');
select rls_test.expect_rows('delivery: chronological history (dispatch, in transit, partial, delivered); manual events marked unverified',
  format($q$ select 1 from public.delivery_events where fulfilment_id = %L and (source = 'SYSTEM' or (source = 'MANUAL' and not verified)) $q$, rls_test.gid('f1', 'fulfilment_id')), 4);
select rls_test.expect_call_error('delivery: a failed delivery needs a reason',
  format($q$ select public.fulfilment_record_delivery(%L, 'DELIVERY_FAILED', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('f2', 'fulfilment_id')), 'reason');
select rls_test.expect_call_ok('delivery: failed delivery recorded as an exception', 'ev4',
  format($q$ select public.fulfilment_record_delivery(%L, 'DELIVERY_FAILED', p_failure_reason => 'Site closed', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('f2', 'fulfilment_id')));
select rls_test.ok('delivery: exception status and reason stored', (rls_test.ful(rls_test.gid('f2', 'fulfilment_id'))).fulfilment_status = 'DELIVERY_EXCEPTION'
  and (rls_test.ful(rls_test.gid('f2', 'fulfilment_id'))).exception_reason = 'Site closed');
select rls_test.expect_call_error('delivery: events cannot be dated in the future',
  format($q$ select public.fulfilment_record_delivery(%L, 'IN_TRANSIT', now() + interval '2 days', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('f3', 'fulfilment_id')), 'future');
-- Time passes for F3 (owner moves the expected date three days back).
reset role;
update public.fulfilments set expected_delivery_date = rls_test.today() - 3 where id = rls_test.gid('f3', 'fulfilment_id');
set local role authenticated;
select rls_test.claims('sales');
select rls_test.ok('overdue: F3 flagged overdue in the fulfilment list', (select is_overdue from public.fulfilment_list where id = rls_test.gid('f3', 'fulfilment_id')));
select rls_test.ok('overdue: F1 (delivered) and F2 (expected in future) are not overdue',
  not (select is_overdue from public.fulfilment_list where id = rls_test.gid('f1', 'fulfilment_id'))
  and not (select is_overdue from public.fulfilment_list where id = rls_test.gid('f2', 'fulfilment_id')));
select rls_test.ok('overdue: overdue report lists F3 with 3 days overdue',
  (select count(*) = 1 and min((r ->> 'days_overdue')::int) = 3 from public.fulfilment_report('OVERDUE_DELIVERY', rls_test.today() - 30, rls_test.today()) r));

-- ===========================================================================
-- 16-18. CUSTOMER RETURNS
-- ===========================================================================
select rls_test.claims('viewer');
select rls_test.expect_call_error('returns: Management Viewer cannot record returns',
  format($q$ select public.customer_return_create(%L, '{"reason_code": "DEFECTIVE"}'::jsonb, '[]'::jsonb, gen_random_uuid()) $q$, rls_test.gid('so1', 'sales_order_id')), 'fulfilment_returns.create');
select rls_test.claims('sales');
select rls_test.expect_call_error('returns: more than was dispatched cannot be returned',
  format($q$ select public.customer_return_create(%L, '{"reason_code": "DEFECTIVE"}'::jsonb, %L::jsonb, gen_random_uuid()) $q$, rls_test.gid('so1', 'sales_order_id'),
    jsonb_build_array(jsonb_build_object('fulfilment_line_id', (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pa'))).id, 'quantity', 25))), 'return between 0 and 24');
select rls_test.expect_call_ok('returns: return of 3 basins requested', 'ret1',
  format($q$ select public.customer_return_create(%L, '{"reason_code": "DEFECTIVE", "reason_note": "hairline cracks"}'::jsonb, %L::jsonb, gen_random_uuid()) $q$, rls_test.gid('so1', 'sales_order_id'),
    jsonb_build_array(jsonb_build_object('fulfilment_line_id', (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pa'))).id, 'quantity', 3))));
select rls_test.expect_call_error('returns: requested returns count against the dispatched quantity (22 > 21 left)',
  format($q$ select public.customer_return_create(%L, '{"reason_code": "DEFECTIVE"}'::jsonb, %L::jsonb, gen_random_uuid()) $q$, rls_test.gid('so1', 'sales_order_id'),
    jsonb_build_array(jsonb_build_object('fulfilment_line_id', (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pa'))).id, 'quantity', 22))), 'return between 0 and 21');
select rls_test.ok('returns: a requested return changes no stock', rls_test.on_hand(rls_test.id('pa')) = 20);
select rls_test.claims('im');
select rls_test.expect_call_error('returns: Inventory Manager cannot authorise returns', format($q$ select public.customer_return_review(%L, 'AUTHORIZE') $q$, rls_test.gid('ret1', 'return_id')),
  'fulfilment_returns.approve');
select rls_test.expect_call_error('returns: goods cannot be received before authorisation',
  format($q$ select public.customer_return_receive(%L, %L, null, null, null, gen_random_uuid()) $q$, rls_test.gid('ret1', 'return_id'), rls_test.id('quar')), 'authorised');
select rls_test.claims('sales');
select rls_test.expect_call_ok('returns: Sales Manager authorises', 'ret1_auth', format($q$ select public.customer_return_review(%L, 'AUTHORIZE', 'approved by phone') $q$, rls_test.gid('ret1', 'return_id')));
select rls_test.ok('returns: an authorised return changes no stock', rls_test.on_hand(rls_test.id('pa')) = 20 and rls_test.available(rls_test.id('pa')) = 20);
select rls_test.claims('im');
select rls_test.expect_call_error('returns: returned goods cannot be received straight into saleable storage',
  format($q$ select public.customer_return_receive(%L, %L, null, null, null, gen_random_uuid()) $q$, rls_test.gid('ret1', 'return_id'), rls_test.id('g1')), 'quarantine');
select rls_test.expect_call_error('returns: the generic Phase 4 "customer return" receipt cannot post into storage either',
  format($q$ select public.inventory_post_receipt(%L, %L, 1, 'IN_HOUSE', p_transaction_type => 'CUSTOMER_RETURN', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.id('pa'), rls_test.id('g1')), 'quarantine');
select rls_test.set('recv_key', to_jsonb(gen_random_uuid()));
select rls_test.expect_call_ok('returns: received into quarantine', 'ret1_recv',
  format($q$ select public.customer_return_receive(%L, %L, null, null, 'three cartons', %L) $q$, rls_test.gid('ret1', 'return_id'), rls_test.id('quar'), rls_test.get('recv_key') #>> '{}'));
select rls_test.ok('returns: on hand +3 in quarantine but available unchanged (not sellable before inspection)',
  rls_test.on_hand(rls_test.id('pa')) = 23 and rls_test.at_location(rls_test.id('pa'), rls_test.id('quar')) = 3 and rls_test.available(rls_test.id('pa')) = 20);
select rls_test.ok('returns: CUSTOMER_RETURN posting into the original dispatched lot; order line returned = 3',
  exists (select 1 from public.inventory_transactions t where t.document_type = 'CUSTOMER_RETURN' and t.transaction_type = 'CUSTOMER_RETURN' and t.quantity = 3
    and t.batch_id = (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pa'))).batch_id)
  and (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('pa'))).quantity_returned = 3);
select rls_test.expect_call_ok('returns: a retried receipt (same key) posts nothing new', 'ret1_recv2',
  format($q$ select public.customer_return_receive(%L, %L, null, null, null, %L) $q$, rls_test.gid('ret1', 'return_id'), rls_test.id('quar'), rls_test.get('recv_key') #>> '{}'));
select rls_test.expect_call_error('returns: a second receipt of the same return is refused',
  format($q$ select public.customer_return_receive(%L, %L, null, null, null, gen_random_uuid()) $q$, rls_test.gid('ret1', 'return_id'), rls_test.id('quar')), 'authorised');
select rls_test.ok('returns: still only one receipt posting (no duplicate)', rls_test.at_location(rls_test.id('pa'), rls_test.id('quar')) = 3
  and (select count(*) from public.inventory_transactions where document_type = 'CUSTOMER_RETURN' and document_id = rls_test.gid('ret1', 'return_id')) = 1);
select rls_test.expect_call_error('returns: dispositions cannot be posted before inspection',
  format($q$ select public.customer_return_post_disposition(%L, %L, null, null, gen_random_uuid()) $q$, rls_test.gid('ret1', 'return_id'), rls_test.id('g1')), 'inspection');
select rls_test.claims('sales');
select rls_test.expect_call_error('returns: Sales Manager cannot inspect returns',
  format($q$ select public.customer_return_inspect(%L, '[]'::jsonb, 'ACCEPTED') $q$, rls_test.gid('ret1', 'return_id')), 'fulfilment_returns.inspect');
select rls_test.claims('im');
select rls_test.expect_call_ok('returns: inspection accepted with disposition RESTOCK', 'ret1_insp',
  format($q$ select public.customer_return_inspect(%L, %L::jsonb, 'ACCEPTED', 'cracks are cosmetic') $q$, rls_test.gid('ret1', 'return_id'),
    jsonb_build_array(jsonb_build_object('line_id', (select id from public.customer_return_lines where return_id = rls_test.gid('ret1', 'return_id')), 'disposition', 'RESTOCK'))));
select rls_test.expect_call_error('returns: restocking needs a storage (sellable) location',
  format($q$ select public.customer_return_post_disposition(%L, %L, null, null, gen_random_uuid()) $q$, rls_test.gid('ret1', 'return_id'), rls_test.id('quar')), 'storage');
select rls_test.expect_call_ok('returns: dispositions posted (transfer quarantine -> W1 storage) and return closed', 'ret1_post',
  format($q$ select public.customer_return_post_disposition(%L, %L, null, null, gen_random_uuid()) $q$, rls_test.gid('ret1', 'return_id'), rls_test.id('g1')));
select rls_test.ok('returns: restocked units are available again only now; quarantine emptied',
  rls_test.available(rls_test.id('pa')) = 23 and rls_test.at_location(rls_test.id('pa'), rls_test.id('quar')) = 0
  and (select status from public.customer_returns where id = rls_test.gid('ret1', 'return_id')) = 'CLOSED'
  and jsonb_array_length(rls_test.get('ret1_post') -> 'transaction_numbers') = 2);

select rls_test.claims('sales');
select rls_test.expect_call_ok('returns: closet return requested and authorised', 'ret2',
  format($q$ select public.customer_return_create(%L, '{"reason_code": "WRONG_ITEM"}'::jsonb, %L::jsonb, gen_random_uuid()) $q$, rls_test.gid('so1', 'sales_order_id'),
    jsonb_build_array(jsonb_build_object('fulfilment_line_id', (rls_test.fl(rls_test.gid('f1', 'fulfilment_id'), rls_test.id('pc'))).id, 'quantity', 1))));
select rls_test.call(format($q$ select public.customer_return_review(%L, 'AUTHORIZE') $q$, rls_test.gid('ret2', 'return_id')));
select rls_test.claims('im');
select rls_test.call(format($q$ select public.customer_return_receive(%L, %L, null, null, null, gen_random_uuid()) $q$, rls_test.gid('ret2', 'return_id'), rls_test.id('quar')));
select rls_test.expect_call_error('returns: a rejected return cannot be restocked',
  format($q$ select public.customer_return_inspect(%L, %L::jsonb, 'REJECTED') $q$, rls_test.gid('ret2', 'return_id'),
    jsonb_build_array(jsonb_build_object('line_id', (select id from public.customer_return_lines where return_id = rls_test.gid('ret2', 'return_id')), 'disposition', 'RESTOCK'))), 'cannot be restocked');
select rls_test.expect_call_ok('returns: damaged closet scrapped (inspection rejected)', 'ret2_insp',
  format($q$ select public.customer_return_inspect(%L, %L::jsonb, 'REJECTED', 'customer damage') $q$, rls_test.gid('ret2', 'return_id'),
    jsonb_build_array(jsonb_build_object('line_id', (select id from public.customer_return_lines where return_id = rls_test.gid('ret2', 'return_id')), 'disposition', 'SCRAP'))));
select rls_test.expect_call_ok('returns: scrap moved to the rejected location (kept apart from sellable stock)', 'ret2_post',
  format($q$ select public.customer_return_post_disposition(%L, null, %L, null, gen_random_uuid()) $q$, rls_test.gid('ret2', 'return_id'), rls_test.id('rej')));
select rls_test.ok('returns: the scrapped closet is in the rejected bay and not available',
  rls_test.at_location(rls_test.id('pc'), rls_test.id('rej')) = 1 and rls_test.available(rls_test.id('pc')) = 2);

-- ===========================================================================
-- BACKORDERS, 12-13. CANCELLATION
-- ===========================================================================
select rls_test.claims('sales');
select rls_test.expect_call_error('backorder: a quantity reduction needs the customer approval note',
  format($q$ select public.sales_order_line_update(%L, null, null, 1, null) $q$, rls_test.id('l_wc')), 'customer approval');
select rls_test.expect_call_ok('backorder: closet reason + expected date recorded, one unit cancelled with the customer''s approval', 'bo',
  format($q$ select public.sales_order_line_update(%L, 'awaiting production', %L, 1, 'customer e-mail 12 Oct') $q$, rls_test.id('l_wc'), rls_test.today() + 10));
select rls_test.ok('backorder: remaining = ordered - cancelled - dispatched (5 - 1 - 3 = 1); reservations/picks are not counted as fulfilled',
  (select quantity_remaining = 1 and quantity_reserved = 0 and quantity_unreserved = 1 and backorder_reason = 'awaiting production'
   from public.sales_order_line_list where id = rls_test.id('l_wc')));
select rls_test.ok('backorder: backorder report lists the closet and the expired-lot sealant line',
  (select count(*) from public.fulfilment_report('BACKORDER', rls_test.today() - 30, rls_test.today()) r where r ->> 'sku' in ('SO-WC')) = 1);

-- SO2 (manual, no dispatches): allocate, pick list, cancel
select rls_test.call(format($q$ select public.sales_order_confirm(%L) $q$, rls_test.gid('so2', 'sales_order_id')));
select rls_test.expect_call_ok('cancel: manual order allocated 5 basins', 'so2_alloc',
  format($q$ select public.sales_order_allocate(%L, 'IN_HOUSE_FIRST', null, true, gen_random_uuid()) $q$, rls_test.gid('so2', 'sales_order_id')));
select rls_test.claims('im');
select rls_test.expect_call_ok('cancel: pick list for the manual order', 'f5',
  format($q$ select public.fulfilment_create(%L, %L, null, null, null, gen_random_uuid()) $q$, rls_test.gid('so2', 'sales_order_id'), rls_test.id('w1')));
select rls_test.expect_call_error('cancel: Inventory Manager cannot cancel orders', format($q$ select public.sales_order_cancel(%L, 'no longer needed', gen_random_uuid()) $q$,
  rls_test.gid('so2', 'sales_order_id')), 'sales_orders.cancel');
select rls_test.claims('sales');
select rls_test.set('cprev', rls_test.call(format($q$ select public.sales_order_cancel_preview(%L) $q$, rls_test.gid('so2', 'sales_order_id'))));
select rls_test.ok('cancel: preview shows the open pick list, the active reservation and no movements',
  (rls_test.get('cprev') ->> 'can_cancel')::boolean and jsonb_array_length(rls_test.get('cprev') -> 'reservations') = 1
  and jsonb_array_length(rls_test.get('cprev') -> 'movements') = 0 and (rls_test.get('cprev') -> 'fulfilments' -> 0 ->> 'will_cancel')::boolean, rls_test.get('cprev')::text);
select rls_test.expect_call_error('cancel: a reason is required', format($q$ select public.sales_order_cancel(%L, '', gen_random_uuid()) $q$, rls_test.gid('so2', 'sales_order_id')), 'reason');
select rls_test.expect_call_ok('cancel: manual order cancelled', 'so2_cancel', format($q$ select public.sales_order_cancel(%L, 'customer withdrew', gen_random_uuid()) $q$, rls_test.gid('so2', 'sales_order_id')));
select rls_test.ok('cancel: its reservation released (only its own), pick list cancelled, no ledger change',
  (rls_test.get('so2_cancel') ->> 'released_quantity')::numeric = 5 and rls_test.reserved(rls_test.id('pa')) = 0 and rls_test.on_hand(rls_test.id('pa')) = 23
  and (rls_test.ful(rls_test.gid('f5', 'fulfilment_id'))).fulfilment_status = 'CANCELLED'
  and (rls_test.so(rls_test.gid('so2', 'sales_order_id'))).order_status = 'CANCELLED' and rls_test.so_reserved((rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('pb'))).id) = 4);
select rls_test.claims('im');
select rls_test.expect_call_error('cancel: a cancelled order accepts no new pick lists',
  format($q$ select public.fulfilment_create(%L, %L, null, null, null, gen_random_uuid()) $q$, rls_test.gid('so2', 'sales_order_id'), rls_test.id('w1')), 'cancelled');

select rls_test.claims('adm');
select rls_test.expect_call_error('release: Administrator lacks fulfilment_reservations.release',
  format($q$ select public.sales_order_release(%L) $q$, rls_test.gid('so1', 'sales_order_id')), 'fulfilment_reservations.release');
select rls_test.claims('sales');
select rls_test.set('cprev1', rls_test.call(format($q$ select public.sales_order_cancel_preview(%L) $q$, rls_test.gid('so1', 'sales_order_id'))));
select rls_test.ok('cancel (partially fulfilled): preview shows the dispatch movements that will be kept',
  (rls_test.get('cprev1') ->> 'has_dispatches')::boolean and jsonb_array_length(rls_test.get('cprev1') -> 'movements') = 5);
select rls_test.expect_call_ok('cancel (partially fulfilled): remaining quantity cancelled', 'so1_cancel',
  format($q$ select public.sales_order_cancel(%L, 'customer closed the PO', gen_random_uuid()) $q$, rls_test.gid('so1', 'sales_order_id')));
select rls_test.ok('cancel (partially fulfilled): sealant reservation released, dispatched 43 kept, ledger untouched',
  (rls_test.get('so1_cancel') ->> 'released_quantity')::numeric = 4 and (rls_test.get('so1_cancel') ->> 'dispatched_kept')::numeric = 43
  and rls_test.reserved(rls_test.id('pb')) = 0 and rls_test.so_issues(rls_test.id('company_a')) = 43
  and (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('pc'))).quantity_cancelled = 2
  and (rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('pa'))).quantity_cancelled = 0);
select rls_test.ok('cancel: delivered consignments keep their delivery state', (rls_test.ful(rls_test.gid('f1', 'fulfilment_id'))).fulfilment_status = 'DELIVERED');
select rls_test.expect_call_ok('cancel: delivery events can still be recorded for goods already on the road', 'ev5',
  format($q$ select public.fulfilment_record_delivery(%L, 'DELIVERED', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('f3', 'fulfilment_id')));
select rls_test.ok('cancel: PO handed back - the closet quantity not on the order (2) can be converted again',
  (select (l ->> 'convertible')::numeric from jsonb_array_elements((public.sales_order_po_preview(rls_test.gid('po', 'po_id'))) -> 'lines') l where l ->> 'sku' = 'SO-WC') = 2);

-- ===========================================================================
-- 19-21. PERMISSIONS, CROSS-COMPANY, REPORTS
-- ===========================================================================
select rls_test.claims('b_sales');
select rls_test.expect_rows('cross-company: company B sees no company A sales orders', 'select * from public.sales_order_list', 0);
select rls_test.expect_rows('cross-company: company B sees no fulfilments, lines, delivery events or returns',
  'select id from public.fulfilment_list union all select id from public.fulfilment_line_list union all select id from public.delivery_events union all select id from public.customer_return_list', 0);
select rls_test.expect_call_error('cross-company: cannot confirm, cancel or allocate a company A order',
  format($q$ select public.sales_order_cancel(%L, 'xx test', gen_random_uuid()) $q$, rls_test.gid('so1', 'sales_order_id')), 'not found');
select rls_test.expect_call_error('cross-company: cannot convert a company A PO',
  format($q$ select public.sales_order_create_from_po(%L, '{}'::jsonb, null, true, false, gen_random_uuid()) $q$, rls_test.gid('po', 'po_id')), 'not found');
select rls_test.expect_call_error('cross-company: cannot record delivery on a company A consignment',
  format($q$ select public.fulfilment_record_delivery(%L, 'IN_TRANSIT', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('f2', 'fulfilment_id')));
select rls_test.expect_call_error('cross-company: cannot create a return against a company A order',
  format($q$ select public.customer_return_create(%L, '{"reason_code": "OTHER"}'::jsonb, '[{"fulfilment_line_id": "00000000-0000-4000-8000-000000000000", "quantity": 1}]'::jsonb, gen_random_uuid()) $q$,
    rls_test.gid('so1', 'sales_order_id')));
select rls_test.ok('cross-company: company B overview is empty', (public.sales_overview(rls_test.today() - 30, rls_test.today()) ->> 'total_orders')::int = 0);

select rls_test.claims('pur');
select rls_test.expect_call_error('reports: Purchase Manager (no fulfilment_reports.read) cannot run fulfilment reports',
  format($q$ select public.fulfilment_report('DISPATCH_REGISTER', %L, %L) $q$, rls_test.today() - 30, rls_test.today()), 'fulfilment_reports.read');
select rls_test.claims('viewer');
select rls_test.ok('reports: Management Viewer may read but not export; Accounts may export',
  private.has_permission(rls_test.id('company_a'), 'fulfilment_reports.read') and not private.has_permission(rls_test.id('company_a'), 'fulfilment_reports.export'));
select rls_test.claims('acc');
select rls_test.ok('reports: Accounts Manager has the export permission', private.has_permission(rls_test.id('company_a'), 'fulfilment_reports.export'));
select rls_test.claims('im');
select rls_test.ok('reports: all 14 reports run on real records',
  (select bool_and(n >= 0) from (select (select count(*) from public.fulfilment_report(k, rls_test.today() - 30, rls_test.today())) n
     from unnest(array['SALES_ORDER_REGISTER', 'PENDING_FULFILMENT', 'PICKING', 'PACKING_STATUS', 'DISPATCH_REGISTER', 'PARTIAL_DISPATCH', 'BACKORDER',
       'DELIVERY_TRACKING', 'OVERDUE_DELIVERY', 'RETURNS_REGISTER', 'EXCEPTIONS', 'TRACEABILITY', 'PRODUCT_DISPATCH_QTY', 'WAREHOUSE_PERFORMANCE']) k) x));
select rls_test.expect_rows('reports: dispatch register has the three consignments',
  format($q$ select * from public.fulfilment_report('DISPATCH_REGISTER', %L, %L) $q$, rls_test.today() - 30, rls_test.today()), 3);
select rls_test.expect_rows('reports: transporter filter (Blue Dart) narrows the dispatch register',
  format($q$ select * from public.fulfilment_report('DISPATCH_REGISTER', %L, %L, p_transporter => 'blue dart') $q$, rls_test.today() - 30, rls_test.today()), 1);
select rls_test.expect_rows('reports: a period before any dispatch returns nothing (dispatch date, not order date, is used)',
  format($q$ select * from public.fulfilment_report('DISPATCH_REGISTER', %L, %L) $q$, rls_test.today() - 60, rls_test.today() - 31), 0);
select rls_test.ok('reports: product dispatch quantity = basin 40 / returned 3',
  (select (r ->> 'dispatched')::numeric = 40 and (r ->> 'returned')::numeric = 3 from public.fulfilment_report('PRODUCT_DISPATCH_QTY', rls_test.today() - 30, rls_test.today()) r where r ->> 'sku' = 'SO-BASIN'));
select rls_test.expect_rows('reports: order-to-dispatch traceability has one row per dispatched lot line (5)',
  format($q$ select * from public.fulfilment_report('TRACEABILITY', %L, %L) $q$, rls_test.today() - 30, rls_test.today()), 5);
select rls_test.ok('reports: partial dispatch report shows the basin line in 3 consignments',
  (select (r ->> 'consignments')::int = 3 from public.fulfilment_report('PARTIAL_DISPATCH', rls_test.today() - 30, rls_test.today()) r where r ->> 'sku' = 'SO-BASIN'));
select rls_test.ok('reports: exceptions report has the pick, packing and delivery exceptions',
  (select count(*) >= 4 from public.fulfilment_report('EXCEPTIONS', rls_test.today() - 30, rls_test.today())));
select rls_test.expect_rows('reports: returns register has both returns', format($q$ select * from public.fulfilment_report('RETURNS_REGISTER', %L, %L) $q$, rls_test.today() - 30, rls_test.today()), 2);
select rls_test.expect_call_error('reports: an invalid period is refused', format($q$ select public.fulfilment_report('PICKING', %L, %L) $q$, rls_test.today(), rls_test.today() - 1), 'date range');
select rls_test.claims('sales');
select rls_test.set('overview', public.sales_overview(rls_test.today() - 30, rls_test.today()));
select rls_test.ok('overview: 2 orders, 0 awaiting confirmation, 43 PCS dispatched in the period, from real records',
  (rls_test.get('overview') ->> 'total_orders')::int = 2 and (rls_test.get('overview') ->> 'awaiting_confirmation')::int = 0
  and (select (u ->> 'quantity')::numeric from jsonb_array_elements(rls_test.get('overview') -> 'units_dispatched') u where u ->> 'unit' = 'PCS') = 43, rls_test.get('overview')::text);
select rls_test.ok('overview: delivery performance counts the delivered consignments; returns by product and reason present',
  (rls_test.get('overview') -> 'delivery_performance' ->> 'delivered')::int = 2 and jsonb_array_length(rls_test.get('overview') -> 'returns_by_product_reason') = 2);
select rls_test.ok('overview: customer filter applies', (public.sales_overview(rls_test.today() - 30, rls_test.today(), gen_random_uuid()) ->> 'total_orders')::int = 0);

-- ===========================================================================
-- 22-24. LEDGER CONSISTENCY, TOTALS, AUDIT
-- ===========================================================================
select rls_test.claims('im');
select rls_test.ok('ledger: balances reconcile with the ledger and reservations after dispatches and returns',
  jsonb_array_length(public.inventory_reconcile() -> 'mismatches') = 0, public.inventory_reconcile()::text);
select rls_test.ok('ledger: basin on hand = 60 received - 40 dispatched + 3 returned = 23; closet 5 - 3 + 1 (scrapped) = 3',
  rls_test.on_hand(rls_test.id('pa')) = 23 and rls_test.on_hand(rls_test.id('pc')) = 3);
select rls_test.ok('totals: order line dispatched/delivered/returned totals match the fulfilment and return records',
  (select sum(quantity_delivered) from public.sales_order_lines where sales_order_id = rls_test.gid('so1', 'sales_order_id'))
    = (select sum(fl.quantity_delivered) from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id where f.sales_order_id = rls_test.gid('so1', 'sales_order_id'))
  and (select sum(quantity_returned) from public.sales_order_lines where sales_order_id = rls_test.gid('so1', 'sales_order_id'))
    = (select sum(rl.quantity_received) from public.customer_return_lines rl join public.customer_returns r on r.id = rl.return_id where r.sales_order_id = rls_test.gid('so1', 'sales_order_id')));
reset role;
select rls_test.ok('audit: order history covers conversion, confirmation, hold, picking, packing, dispatch, delivery, returns and cancellation',
  rls_test.events(rls_test.gid('so1', 'sales_order_id')) @> array['CREATED_FROM_PO', 'CONFIRMED', 'HOLD', 'RESUME', 'FULFILMENT_CREATED', 'PICKING_COMPLETED',
    'PACKING_COMPLETED', 'FULFILMENT_REOPEN_PACKING', 'FULFILMENT_READY', 'DISPATCHED', 'DELIVERY_IN_TRANSIT', 'DELIVERY_PARTIALLY_DELIVERED', 'DELIVERY_DELIVERED',
    'DELIVERY_DELIVERY_FAILED', 'RETURN_REQUESTED', 'RETURN_AUTHORIZED', 'RETURN_RECEIVED', 'RETURN_ACCEPTED', 'RETURN_REJECTED', 'RETURN_CLOSED',
    'LINE_QUANTITY_REDUCED', 'CANCELLED'], array_to_string(rls_test.events(rls_test.gid('so1', 'sales_order_id')), ','));
select rls_test.ok('audit: every event records the acting user', not exists (select 1 from public.sales_order_events where company_id = rls_test.id('company_a') and actor_user_id is null));
select rls_test.ok('audit: PO history records the conversion', exists (select 1 from public.customer_po_events where purchase_order_id = rls_test.gid('po', 'po_id') and event_type = 'CONVERTED_TO_SALES_ORDER'));
select rls_test.ok('audit: audit log has the dispatch entry', exists (select 1 from public.audit_logs where company_id = rls_test.id('company_a') and action = 'sales_order.dispatched'));
select rls_test.expect_error('audit: order history is append-only (even for the owner)',
  format($q$ update public.sales_order_events set note = 'changed' where sales_order_id = %L $q$, rls_test.gid('so1', 'sales_order_id')));
select rls_test.expect_error('audit: delivery history is append-only (even for the owner)',
  format($q$ delete from public.delivery_events where fulfilment_id = %L $q$, rls_test.gid('f1', 'fulfilment_id')));

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
  raise exception 'SALES_FULFILMENT_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
