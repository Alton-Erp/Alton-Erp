-- =============================================================================
-- SINGLE-OPERATOR MODE VERIFICATION (ALTON ERP V2, Step 0)
--
-- Checks migration 20261101090000_single_operator_mode.sql: one user can run
-- the whole cycle alone (open a PO, receive goods, activate a BOM, release a
-- production order, post opening stock, adjustments and counts) with no second
-- approver; segregation of duties still works when a company switches it on;
-- retries never post twice; company isolation and anon access are unchanged.
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction and ALWAYS ends by raising
--   SINGLE_OPERATOR_VERIFICATION_RESULT passed=N failed=M
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

-- Owner-side probes (bypass RLS) used to assert stored state.
create function rls_test.on_hand(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(on_hand), 0) from public.inventory_balances where product_id = p_product $$;
create function rls_test.ledger_count(p_company uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.inventory_transactions where company_id = p_company $$;
create function rls_test.po_status(p_po uuid) returns text language sql stable security definer as $$
  select status from public.purchase_orders where id = p_po $$;
create function rls_test.po_approved_by(p_po uuid) returns uuid language sql stable security definer as $$
  select approved_by from public.purchase_orders where id = p_po $$;
create function rls_test.po_line(p_po uuid) returns uuid language sql stable security definer as $$
  select id from public.purchase_order_lines where purchase_order_id = p_po order by line_no limit 1 $$;
create function rls_test.bom_status(p_bom uuid) returns text language sql stable security definer as $$
  select status from public.boms where id = p_bom $$;
create function rls_test.order_status(p_order uuid) returns text language sql stable security definer as $$
  select status from public.production_orders where id = p_order $$;
create function rls_test.count_line(p_count uuid, p_product uuid) returns uuid language sql stable security definer as $$
  select id from public.inventory_count_lines where count_id = p_count and product_id = p_product limit 1 $$;
create function rls_test.count_status(p_count uuid) returns text language sql stable security definer as $$
  select status from public.inventory_counts where id = p_count $$;
create function rls_test.adjustments(p_company uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.inventory_adjustments where company_id = p_company $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures: company A run by ONE operator; company B for isolation
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5c100-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5c100-0000-4000-8000-0000000000b1'),
  ('op',   'e7e5c100-0000-4000-8000-000000000001'),   -- the only user of company A (Super Admin)
  ('b_op', 'e7e5c100-0000-4000-8000-000000000002'),   -- Super Admin of company B
  ('sup',  'e7e5c100-0000-4000-8000-0000000000c1'),
  ('fg',   'e7e5c100-0000-4000-8000-0000000000d1'), ('clay', 'e7e5c100-0000-4000-8000-0000000000d2'),
  ('kit',  'e7e5c100-0000-4000-8000-0000000000d3'),
  ('w1',   'e7e5c100-0000-4000-8000-0000000000e1'), ('wb', 'e7e5c100-0000-4000-8000-0000000000e2');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code, gstin, legal_address) values
  (rls_test.id('company_a'), 'Single Operator A Pvt Ltd', 'Single Operator A', 'SOPA', '27AAACA1234A1Z5', 'Plot 1, MIDC, Pune'),
  (rls_test.id('company_b'), 'Single Operator B', 'Single Operator B', 'SOPB', null, null);
insert into auth.users (id, email) select id, key || '@sop.example.invalid' from rls_test.ids where key in ('op', 'b_op');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = rls_test.id('op');
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_op');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('op'),   rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('b_op'), rls_test.id('company_b'), rls_test.id('role_super_admin'));

insert into public.suppliers (id, company_id, supplier_code, legal_name, gstin, state_code, payment_terms, status) values
  (rls_test.id('sup'), rls_test.id('company_a'), 'S-CLAY', 'Clay Supplier', '27AAPFU0939F1ZV', '27', 'DAYS_30', 'ACTIVE');
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, track_batches, track_expiry, status,
  hsn_code, gst_rate) values
  (rls_test.id('fg'),   rls_test.id('company_a'), 'SOP-WC',   'Wall-hung WC',  'FINISHED_GOOD', 'IN_HOUSE',   'PCS', false, false, 'ACTIVE', '6910', 18),
  (rls_test.id('clay'), rls_test.id('company_a'), 'SOP-CLAY', 'Ball clay',     'RAW_MATERIAL',  'OUTSOURCED', 'KG',  false, false, 'ACTIVE', '2508', 5),
  (rls_test.id('kit'),  rls_test.id('company_a'), 'SOP-KIT',  'Fitting kit',   'COMPONENT',     'OUTSOURCED', 'PCS', false, false, 'ACTIVE', '7318', 18);
-- Opening stock is priced at the Product Master Cost (migration 20261129090000): the products get the cost the lines used before.
update public.products set standard_cost = case id when rls_test.id('kit') then 40 else 500 end, change_reason = 'test: Product Master Cost for opening stock'
  where id in (rls_test.id('kit'), rls_test.id('fg'));
insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default, address) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Main', true, 'Gate 2, MIDC'),
  (rls_test.id('wb'), rls_test.id('company_b'), 'W1', 'B main', true, null);
insert into rls_test.ids (key, id)
select case warehouse_id when rls_test.id('w1') then 'g1' else 'gb' end, id
from public.inventory_locations where location_code = 'GENERAL' and warehouse_id in (rls_test.id('w1'), rls_test.id('wb'));

-- ---------------------------------------------------------------------------
-- Policy and grants
-- ---------------------------------------------------------------------------
select rls_test.ok('policy: segregation of duties is OFF by default in V2',
  (private.inventory_policy(rls_test.id('company_a')) ->> 'segregation_of_duties')::boolean = false
  and (private.production_policy(rls_test.id('company_a')) ->> 'segregation_of_duties')::boolean = false);
select rls_test.ok('grants: anon cannot call any one-step action; authenticated can',
  not has_function_privilege('anon', 'public.purchase_order_open(uuid, timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.production_bom_activate(uuid, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.production_order_release(uuid, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.outsourcing_order_release(uuid, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.inventory_post_adjustment(text, uuid, uuid, text, uuid, text, text, numeric, numeric, text, numeric, text, text, date, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.inventory_post_opening_stock(jsonb, text, text, text, uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.inventory_post_opening_stock(jsonb, text, text, text, uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.inventory_post_opening_stock_at_cost(jsonb, text, text, text, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.inventory_post_count(uuid, text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.purchase_order_open(uuid, timestamptz)', 'EXECUTE'));
select rls_test.ok('grants: one-step actions add no privileges (SECURITY INVOKER)',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.prosecdef
                and p.proname in ('purchase_order_open', 'production_bom_activate', 'production_order_release', 'outsourcing_order_release',
                                  'inventory_post_adjustment', 'inventory_post_opening_stock', 'inventory_post_count')));

-- ---------------------------------------------------------------------------
-- Opening stock: one step, no approver
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('opening: the operator posts opening stock in one step', 'open1',
  format($q$ select public.inventory_post_opening_stock_at_cost(%L::jsonb, 'MANUAL', null, 'Go-live', 'e7e5c100-0000-4000-8000-00000000ab01') $q$,
    jsonb_build_array(jsonb_build_object('line_no', 1, 'product_id', rls_test.id('kit'), 'location_id', rls_test.id('g1'),
      'source_type', 'OUTSOURCED', 'quantity', 50, 'unit_cost', 40, 'effective_date', rls_test.today()))));
reset role;
select rls_test.ok('opening: status POSTED and 50 kits on hand', rls_test.get('open1') ->> 'status' = 'POSTED'
  and rls_test.on_hand(rls_test.id('kit')) = 50, rls_test.get('open1')::text);
select rls_test.ok('opening: posted at the Product Master Cost (40)',
  (select unit_cost from public.inventory_transactions where product_id = rls_test.id('kit') and transaction_type = 'OPENING_STOCK') = 40);
select rls_test.set('ledger_after_open', to_jsonb(rls_test.ledger_count(rls_test.id('company_a'))));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('opening: a retry with the same request id is accepted', 'open1_retry',
  format($q$ select public.inventory_post_opening_stock_at_cost(%L::jsonb, 'MANUAL', null, 'Go-live', 'e7e5c100-0000-4000-8000-00000000ab01') $q$,
    jsonb_build_array(jsonb_build_object('line_no', 1, 'product_id', rls_test.id('kit'), 'location_id', rls_test.id('g1'),
      'source_type', 'OUTSOURCED', 'quantity', 50, 'unit_cost', 40, 'effective_date', rls_test.today()))));
reset role;
select rls_test.ok('opening: ...and posts nothing twice (still 50, same ledger count, same document)',
  rls_test.on_hand(rls_test.id('kit')) = 50
  and rls_test.ledger_count(rls_test.id('company_a')) = (rls_test.get('ledger_after_open'))::bigint
  and rls_test.get('open1_retry') ->> 'opening_batch_id' = rls_test.get('open1') ->> 'opening_batch_id', rls_test.get('open1_retry')::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.set('open_bad', rls_test.call(format($q$ select public.inventory_post_opening_stock_at_cost(%L::jsonb, 'MANUAL', null, null, gen_random_uuid()) $q$,
    jsonb_build_array(jsonb_build_object('line_no', 1, 'product_id', rls_test.id('fg'), 'location_id', rls_test.id('g1'),
      'source_type', 'IN_HOUSE', 'quantity', -3, 'effective_date', rls_test.today())))));
reset role;
select rls_test.ok('opening: invalid lines come back as errors and nothing is posted',
  (rls_test.get('open_bad') ->> 'ok') = 'false' and rls_test.on_hand(rls_test.id('fg')) = 0, rls_test.get('open_bad')::text);

-- ---------------------------------------------------------------------------
-- Stock adjustment: one step, retry-safe
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('adjustment: the operator records and posts a count variance (50 -> 47) in one step', 'adj1',
  format($q$ select public.inventory_post_adjustment('QUANTITY', %L, %L, 'COUNT_VARIANCE',
             p_batch_id => (select batch_id from public.inventory_balances where product_id = %L limit 1),
             p_counted_quantity => 47, p_notes => 'Shelf count', p_idempotency_key => 'e7e5c100-0000-4000-8000-00000000ab02') $q$,
    rls_test.id('kit'), rls_test.id('g1'), rls_test.id('kit')));
reset role;
select rls_test.ok('adjustment: status POSTED, 47 kits on hand', rls_test.get('adj1') ->> 'status' = 'POSTED'
  and rls_test.on_hand(rls_test.id('kit')) = 47, rls_test.get('adj1')::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('adjustment: a retry with the same request id is accepted', 'adj1_retry',
  format($q$ select public.inventory_post_adjustment('QUANTITY', %L, %L, 'COUNT_VARIANCE',
             p_batch_id => (select batch_id from public.inventory_balances where product_id = %L limit 1),
             p_counted_quantity => 47, p_notes => 'Shelf count', p_idempotency_key => 'e7e5c100-0000-4000-8000-00000000ab02') $q$,
    rls_test.id('kit'), rls_test.id('g1'), rls_test.id('kit')));
reset role;
select rls_test.ok('adjustment: ...and does not post twice (still 47, one adjustment)',
  rls_test.on_hand(rls_test.id('kit')) = 47 and rls_test.adjustments(rls_test.id('company_a')) = 1
  and rls_test.get('adj1_retry') ->> 'adjustment_id' = rls_test.get('adj1') ->> 'adjustment_id', rls_test.get('adj1_retry')::text);

-- ---------------------------------------------------------------------------
-- Physical count: one step
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('count: the operator starts a count of W1', 'c1',
  format($q$ select public.inventory_create_count(%L, p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('w1')));
reset role;
select rls_test.set('c1_line', to_jsonb(rls_test.count_line(rls_test.gid('c1', 'count_id'), rls_test.id('kit'))));
set local role authenticated;
select rls_test.claims('op');
select rls_test.call(format($q$ select public.inventory_record_count(%L, %L::jsonb) $q$, rls_test.gid('c1', 'count_id'),
  jsonb_build_array(jsonb_build_object('line_id', rls_test.get('c1_line') #>> '{}', 'counted_quantity', 45))));
select rls_test.expect_call_ok('count: the operator submits and posts the count in one step', 'c1_post',
  format($q$ select public.inventory_post_count(%L, 'Year-end count') $q$, rls_test.gid('c1', 'count_id')));
reset role;
select rls_test.ok('count: count POSTED and the variance applied (47 -> 45)',
  rls_test.count_status(rls_test.gid('c1', 'count_id')) = 'POSTED' and rls_test.on_hand(rls_test.id('kit')) = 45,
  coalesce(rls_test.count_status(rls_test.gid('c1', 'count_id')), 'null') || ' / ' || rls_test.on_hand(rls_test.id('kit')));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('count: posting the same count again is refused with a clear message',
  format($q$ select public.inventory_post_count(%L) $q$, rls_test.gid('c1', 'count_id')), 'already posted');

-- ---------------------------------------------------------------------------
-- Purchase order: open in one step, then receive
-- ---------------------------------------------------------------------------
select rls_test.expect_call_ok('po: the operator saves a draft PO for 100 KG clay', 'po1',
  format('select public.purchase_order_save(null, %L::jsonb, %L::jsonb, null, %L)',
    jsonb_build_object('supplier_id', rls_test.id('sup'), 'purchase_type', 'RAW_MATERIAL', 'warehouse_id', rls_test.id('w1'),
      'expected_delivery_date', (rls_test.today() + 7)::text),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('clay'), 'quantity', 100, 'unit_price', 12)),
    'e7e5c100-0000-4000-8000-00000000ab03'));
select rls_test.expect_call_ok('po: the operator opens their own PO in one step (no second approver)', 'po1_open',
  format('select public.purchase_order_open(%L)', rls_test.gid('po1', 'po_id')));
reset role;
select rls_test.ok('po: status APPROVED (open for receipt), approved by the operator',
  rls_test.po_status(rls_test.gid('po1', 'po_id')) = 'APPROVED' and rls_test.po_approved_by(rls_test.gid('po1', 'po_id')) = rls_test.id('op'),
  rls_test.get('po1_open')::text);
select rls_test.set('po1_line', to_jsonb(rls_test.po_line(rls_test.gid('po1', 'po_id'))));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('po: opening it again says it is already open',
  format('select public.purchase_order_open(%L)', rls_test.gid('po1', 'po_id')), 'already open');
select rls_test.expect_call_ok('grn: the operator receives 60 KG against the open PO', 'grn1',
  format('select public.purchase_receipt_post(%L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('po1', 'po_id'),
    jsonb_build_object('receipt_date', rls_test.today()::text),
    jsonb_build_array(jsonb_build_object('po_line_id', rls_test.get('po1_line') #>> '{}', 'received_quantity', 60, 'accepted_quantity', 60,
      'rejected_quantity', 0, 'accepted_location_id', rls_test.id('g1'))),
    'e7e5c100-0000-4000-8000-00000000ab04'));
reset role;
select rls_test.ok('grn: 60 KG clay in stock and the PO is PARTIALLY_RECEIVED',
  rls_test.on_hand(rls_test.id('clay')) = 60 and rls_test.po_status(rls_test.gid('po1', 'po_id')) = 'PARTIALLY_RECEIVED',
  rls_test.get('grn1')::text);

-- ---------------------------------------------------------------------------
-- BOM and production order: one step each
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('bom: the operator saves a BOM (2 KG clay + 1 kit per WC)', 'bom1',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, 'WC standard', %L::jsonb, gen_random_uuid()) $q$,
    rls_test.id('fg'), rls_test.today(), jsonb_build_array(
      jsonb_build_object('component_product_id', rls_test.id('clay'), 'quantity_required', 2),
      jsonb_build_object('component_product_id', rls_test.id('kit'), 'quantity_required', 1))));
select rls_test.expect_call_ok('bom: the operator activates their own BOM in one step', 'bom1_on',
  format('select public.production_bom_activate(%L)', rls_test.gid('bom1', 'bom_id')));
reset role;
select rls_test.ok('bom: status APPROVED (active)', rls_test.bom_status(rls_test.gid('bom1', 'bom_id')) = 'APPROVED', rls_test.get('bom1_on')::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('production: the operator creates an order for 10 WC', 'p1',
  format($q$ select public.production_save_order(null, %L, 10, %L, %L, %L, %L, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('bom1', 'bom_id'), rls_test.id('w1'), rls_test.id('w1'), rls_test.today(), rls_test.today() + 5));
select rls_test.expect_call_ok('production: the operator releases it in one step', 'p1_rel',
  format('select public.production_order_release(%L)', rls_test.gid('p1', 'order_id')));
reset role;
select rls_test.ok('production: status APPROVED (ready to reserve and start)',
  rls_test.order_status(rls_test.gid('p1', 'order_id')) = 'APPROVED', rls_test.get('p1_rel')::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('production: the released order can be started straight away', 'p1_start',
  format($q$ select public.production_order_action(%L, 'START') $q$, rls_test.gid('p1', 'order_id')));

-- ---------------------------------------------------------------------------
-- Segregation of duties still works when a company switches it on
-- ---------------------------------------------------------------------------
reset role;
insert into public.company_settings (company_id, setting_key, setting_value)
values (rls_test.id('company_a'), 'inventory.segregation_of_duties', 'true'::jsonb);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('sod on: a new draft PO is saved', 'po2',
  format('select public.purchase_order_save(null, %L::jsonb, %L::jsonb, null, %L)',
    jsonb_build_object('supplier_id', rls_test.id('sup'), 'purchase_type', 'RAW_MATERIAL', 'warehouse_id', rls_test.id('w1')),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('clay'), 'quantity', 5, 'unit_price', 12)),
    'e7e5c100-0000-4000-8000-00000000ab05'));
select rls_test.expect_call_error('sod on: the creator cannot open their own PO',
  format('select public.purchase_order_open(%L)', rls_test.gid('po2', 'po_id')), 'Segregation');
reset role;
select rls_test.ok('sod on: the refused open changed nothing (PO still DRAFT, not left pending)',
  rls_test.po_status(rls_test.gid('po2', 'po_id')) = 'DRAFT');

-- ---------------------------------------------------------------------------
-- Company isolation
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('b_op');
select rls_test.expect_call_error('isolation: company B cannot open company A''s PO',
  format('select public.purchase_order_open(%L)', rls_test.gid('po2', 'po_id')), 'not found');
select rls_test.expect_call_error('isolation: company B cannot activate company A''s BOM',
  format('select public.production_bom_activate(%L)', rls_test.gid('bom1', 'bom_id')), 'not found');
select rls_test.expect_call_error('isolation: company B cannot post company A''s count',
  format('select public.inventory_post_count(%L)', rls_test.gid('c1', 'count_id')), 'not found');
reset role;

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
  raise exception 'SINGLE_OPERATOR_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
