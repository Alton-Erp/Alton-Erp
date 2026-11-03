-- =============================================================================
-- DISPATCH BEFORE INVOICE POSTING (ALTON ERP V2)
-- migration 20261112090000_invoice_dispatch_policy.sql
--
--  1 manual stock invoice without dispatch is blocked   10 non-stock classification
--  2 a draft (unposted) dispatch does not count          11 posting deducts no stock (no double deduction)
--  3 a cancelled dispatch does not count                 12 a repeated post is not duplicated
--  4 a reversed dispatch does not count (replacement ok) 13 concurrent / stale postings cannot bypass
--  5 partial dispatch is blocked                         14 reversal updates the valid dispatched quantity
--  6 full dispatch allows posting                        15 company isolation
--  7 multiple dispatches combine                         16 units and fractional quantities
--  8 service-only invoice posts                          17 a failed post leaves invoice and ledger unchanged
--  9 mixed invoice: only the goods are enforced          18 (existing suites: npm run test:db)
--
--   locally:      npm run test:db   (DB_SUITE=invoice_dispatch_policy for this one)
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
-- Runs in one transaction and ALWAYS ends by raising
--   INVOICE_DISPATCH_POLICY_RESULT passed=N failed=M
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

create function rls_test.save(p_header jsonb, p_lines jsonb, p_charges jsonb default null) returns text language sql stable as $$
  select format('select public.sales_invoice_v2_save(null, %L::jsonb, %L::jsonb, %L::jsonb, %L)', p_header, p_lines, p_charges, gen_random_uuid()) $$;
-- Since 20261115 sales_invoice_v2_issue first dispatches undispatched sales-order lines
-- ("posting is the dispatch"; tested in partial_invoicing_verification.sql). The checks
-- below exercise the posting rule itself, which still guards every path to ISSUED: without
-- a request key they post through the issue core (no dispatch on posting); with a key they
-- use the public RPC.
create function rls_test.issue_strict(p_id uuid) returns jsonb language plpgsql security definer as $$
begin
  return private.invoice_v2_issue_core((select company_id from public.sales_invoices where id = p_id), p_id, null);
end $$;
create function rls_test.issue(p_id uuid, p_key uuid default null) returns text language sql stable as $$
  select case when p_key is null then format('select rls_test.issue_strict(%L)', p_id)
    else format('select public.sales_invoice_v2_issue(%L, false, %L)', p_id, p_key) end $$;
create function rls_test.status(p_id uuid) returns text language sql stable as $$
  select format('select public.invoice_dispatch_status(%L)', p_id) $$;
create function rls_test.ln(p_product uuid, p_qty numeric, p_extra jsonb default '{}'::jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('product_id', p_product, 'quantity', p_qty) || p_extra $$;
create function rls_test.grn(p_product uuid, p_qty numeric) returns text language sql stable as $$
  select format('select public.goods_receipt_direct_post(%L::jsonb, %L::jsonb, %L)', jsonb_build_object('warehouse_id', rls_test.id('w1')),
    jsonb_build_array(jsonb_build_object('product_id', p_product, 'received_quantity', p_qty, 'accepted_quantity', p_qty, 'unit_cost', 10,
      'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()) $$;
create function rls_test.so(p_product uuid, p_qty numeric) returns text language sql stable as $$
  select format('select public.sales_order_v2_save(null, %L::jsonb, %L::jsonb, %L)', jsonb_build_object('customer_id', rls_test.id('cx')),
    jsonb_build_array(jsonb_build_object('product_id', p_product, 'quantity', p_qty)), gen_random_uuid()) $$;
create function rls_test.dispatch(p_so uuid, p_qty numeric) returns text language sql stable as $$
  select format('select public.sales_order_v2_dispatch(%L, %L::jsonb, ''{}''::jsonb, %L)', p_so,
    jsonb_build_array(jsonb_build_object('line_id', (select id from public.sales_order_lines where sales_order_id = p_so order by line_no limit 1), 'quantity', p_qty)),
    gen_random_uuid()) $$;
-- Sales-order invoice for the first line of an order.
create function rls_test.so_inv(p_so uuid, p_qty numeric, p_charges jsonb default null) returns text language sql stable security definer as $$
  select rls_test.save(jsonb_build_object('sales_order_id', p_so),
    jsonb_build_array(jsonb_build_object('product_id', l.product_id, 'quantity', p_qty, 'sales_order_line_id', l.id)), p_charges)
  from public.sales_order_lines l where l.sales_order_id = p_so order by l.line_no limit 1 $$;
create function rls_test.st_line(p_status jsonb, p_no int) returns jsonb language sql immutable as $$
  select l from jsonb_array_elements(p_status -> 'lines') l where (l ->> 'line_no')::int = p_no $$;
-- Owner-side probes (bypass RLS).
create function rls_test.inv(p_id uuid) returns public.sales_invoices language sql stable security definer as $$ select * from public.sales_invoices where id = p_id $$;
create function rls_test.on_hand(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(on_hand), 0) from public.inventory_balances where product_id = p_product $$;
create function rls_test.tx_count(p_company uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.inventory_transactions where company_id = p_company $$;
create function rls_test.events(p_id uuid, p_type text) returns bigint language sql stable security definer as $$
  select count(*) from public.billing_events where invoice_id = p_id and event_type = p_type $$;
create function rls_test.fulfilments(p_so uuid) returns uuid[] language sql stable security definer as $$
  select array_agg(id order by created_at, fulfilment_number) from public.fulfilments where sales_order_id = p_so $$;
create function rls_test.fl_of(p_f uuid) returns uuid language sql stable security definer as $$
  select id from public.fulfilment_lines where fulfilment_id = p_f order by line_no limit 1 $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5cd00-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5cd00-0000-4000-8000-0000000000b1'),
  ('op', 'e7e5cd00-0000-4000-8000-000000000001'), ('b_op', 'e7e5cd00-0000-4000-8000-000000000002'),
  ('cx', 'e7e5cd00-0000-4000-8000-0000000000c1'), ('cb', 'e7e5cd00-0000-4000-8000-0000000000c2'),
  ('fg', 'e7e5cd00-0000-4000-8000-0000000000d1'), ('kg', 'e7e5cd00-0000-4000-8000-0000000000d2'),
  ('svc', 'e7e5cd00-0000-4000-8000-0000000000d3'), ('fgb', 'e7e5cd00-0000-4000-8000-0000000000d4'),
  ('w1', 'e7e5cd00-0000-4000-8000-0000000000e1'), ('wb', 'e7e5cd00-0000-4000-8000-0000000000e2'),
  ('k_post', 'e7e5cd00-0000-4000-8000-0000000000f1');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code, gstin, legal_address) values
  (rls_test.id('company_a'), 'Dispatch Policy A Pvt Ltd', 'DP A', 'DPA', '27AAACD1234A1Z5', 'Pune'),
  (rls_test.id('company_b'), 'Dispatch Policy B', 'DP B', 'DPB', '27AAACD5678B1Z5', 'Nashik');
insert into auth.users (id, email) select id, key || '@dp.example.invalid' from rls_test.ids where key in ('op', 'b_op');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = rls_test.id('op');
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_op');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('op'), rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('b_op'), rls_test.id('company_b'), rls_test.id('role_super_admin'));
insert into public.customers (id, company_id, customer_code, customer_name, status, gstin, gst_registration_type, billing_state_code, billing_address) values
  (rls_test.id('cx'), rls_test.id('company_a'), 'DP-CX', 'Xylo Homes', 'ACTIVE', '27AABCX1234A1Z5', 'REGISTERED', '27', 'Pune'),
  (rls_test.id('cb'), rls_test.id('company_b'), 'DP-CB', 'B customer', 'ACTIVE', null, 'UNREGISTERED', '27', 'Pune');
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, status, selling_price, gst_rate, hsn_code) values
  (rls_test.id('fg'), rls_test.id('company_a'), 'DP-FG', 'Basin mixer', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', 1000, 18, '84818020'),
  (rls_test.id('kg'), rls_test.id('company_a'), 'DP-KG', 'Glaze powder', 'FINISHED_GOOD', 'OUTSOURCED', 'KG', 'ACTIVE', 200, 5, '3207'),
  (rls_test.id('fgb'), rls_test.id('company_b'), 'DP-FG', 'B mixer', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', 1000, 18, '84818020');
-- A service / non-stock item (installation) set up by the operator.
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, status, selling_price, gst_rate, hsn_code, inventory_tracked) values
  (rls_test.id('svc'), rls_test.id('company_a'), 'DP-SVC', 'Installation service', 'FINISHED_GOOD', 'OUTSOURCED', 'NOS', 'ACTIVE', 500, 18, '995461', false);
insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Factory', true), (rls_test.id('wb'), rls_test.id('company_b'), 'W1', 'B factory', true);
insert into rls_test.ids (key, id)
select case warehouse_id when rls_test.id('w1') then 'g1' else 'gb' end, id
from public.inventory_locations where location_code = 'GENERAL' and warehouse_id in (rls_test.id('w1'), rls_test.id('wb'));

select rls_test.ok('10. existing / new products are stock items by default; the service product is non-stock',
  (select inventory_tracked from public.products where id = rls_test.id('fg')) and not (select inventory_tracked from public.products where id = rls_test.id('svc')));

set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('setup: 100 basin mixers in stock', 'g_fg', rls_test.grn(rls_test.id('fg'), 100));
select rls_test.expect_call_ok('setup: 20 KG glaze powder in stock', 'g_kg', rls_test.grn(rls_test.id('kg'), 20));
reset role;
select rls_test.set('tx0', to_jsonb(rls_test.tx_count(rls_test.id('company_a'))));

-- ---------------------------------------------------------------------------
-- 1, 17. Manual stock invoice without dispatch; a failed post changes nothing
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('1. manual draft: 5 basin mixers (no dispatch)', 'm1',
  rls_test.save(jsonb_build_object('customer_id', rls_test.id('cx')), jsonb_build_array(rls_test.ln(rls_test.id('fg'), 5))));
select rls_test.expect_call_ok('1. dispatch status of the manual draft', 'm1s', rls_test.status(rls_test.gid('m1', 'invoice_id')));
select rls_test.set('m1err', rls_test.call(rls_test.issue(rls_test.gid('m1', 'invoice_id'))));
reset role;
select rls_test.ok('1. posting a manual stock invoice without dispatch is refused',
  rls_test.get('m1err') ->> 'error' ilike '%Dispatch the goods before posting%', rls_test.get('m1err')::text);
select rls_test.ok('1. the error names the product and shows invoiced 5, dispatched 0, remaining 5',
  rls_test.get('m1err') ->> 'error' ilike '%DP-FG Basin mixer: invoiced 5 PCS, validly dispatched 0, still to dispatch 5%'
  and rls_test.get('m1err') ->> 'error' ilike '%Not linked to a sales order or dispatch%', rls_test.get('m1err')::text);
select rls_test.ok('1. status: AWAITING_DISPATCH (5 required, 0 dispatched, 5 remaining), not ready',
  rls_test.st_line(rls_test.get('m1s'), 1) ->> 'status' = 'AWAITING_DISPATCH' and (rls_test.st_line(rls_test.get('m1s'), 1) ->> 'required')::numeric = 5
  and (rls_test.st_line(rls_test.get('m1s'), 1) ->> 'remaining')::numeric = 5 and not (rls_test.get('m1s') ->> 'ready')::boolean
  and (rls_test.get('m1s') ->> 'outstanding_lines')::int = 1, rls_test.get('m1s')::text);
select rls_test.ok('17. failed post: invoice still DRAFT, no number, no ISSUED event, no stock movement, stock 100',
  (rls_test.inv(rls_test.gid('m1', 'invoice_id'))).status = 'DRAFT' and (rls_test.inv(rls_test.gid('m1', 'invoice_id'))).invoice_number is null
  and rls_test.events(rls_test.gid('m1', 'invoice_id'), 'ISSUED') = 0
  and rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx0'))::bigint and rls_test.on_hand(rls_test.id('fg')) = 100);

-- ---------------------------------------------------------------------------
-- 2, 3. Draft and cancelled consignments do not count
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('setup: order A for 10 basin mixers (reserved)', 'soa', rls_test.so(rls_test.id('fg'), 10));
select rls_test.expect_call_ok('2. draft consignment (pick list) for all 10, not dispatched', 'fdraft',
  format('select public.fulfilment_create(%L, %L, null, null, null, %L)', rls_test.gid('soa', 'sales_order_id'), rls_test.id('w1'), gen_random_uuid()));
select rls_test.expect_call_ok('2. invoice 10 from order A (draft)', 'ia', rls_test.so_inv(rls_test.gid('soa', 'sales_order_id'), 10));
select rls_test.expect_call_error('2. posting with only a draft consignment is refused', rls_test.issue(rls_test.gid('ia', 'invoice_id')), 'still to dispatch 10');
select rls_test.expect_call_ok('3. cancel the draft consignment', 'fcancel',
  format('select public.fulfilment_action(%L, %L, %L)', rls_test.gid('fdraft', 'fulfilment_id'), 'CANCEL', 'Customer changed the schedule'));
select rls_test.expect_call_error('3. posting with a cancelled consignment is refused', rls_test.issue(rls_test.gid('ia', 'invoice_id')), 'still to dispatch 10');
reset role;
select rls_test.ok('2-3. draft and cancelled consignments moved no stock (100 on hand)', rls_test.on_hand(rls_test.id('fg')) = 100);

-- ---------------------------------------------------------------------------
-- 5, 7, 6, 11, 12. Partial dispatch blocked; dispatches combine; full dispatch posts
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('5. dispatch 4 of 10', 'da1', rls_test.dispatch(rls_test.gid('soa', 'sales_order_id'), 4));
select rls_test.expect_call_ok('5. status after 4 dispatched', 'ias1', rls_test.status(rls_test.gid('ia', 'invoice_id')));
select rls_test.expect_call_error('5. partial dispatch (4 of 10): posting refused with 4 dispatched, 6 remaining',
  rls_test.issue(rls_test.gid('ia', 'invoice_id')), 'validly dispatched 4, still to dispatch 6');
select rls_test.expect_call_ok('7. second dispatch: 6 more', 'da2', rls_test.dispatch(rls_test.gid('soa', 'sales_order_id'), 6));
select rls_test.expect_call_ok('7. status after 4 + 6 dispatched', 'ias2', rls_test.status(rls_test.gid('ia', 'invoice_id')));
reset role;
-- Since 20261115 an undispatched order line shows DISPATCH_ON_POSTING (posting dispatches it).
select rls_test.ok('5. status: 4 / 10 dispatched, remaining 6 (dispatched on posting), order number shown',
  rls_test.st_line(rls_test.get('ias1'), 1) ->> 'status' = 'DISPATCH_ON_POSTING' and (rls_test.st_line(rls_test.get('ias1'), 1) ->> 'dispatch_on_posting')::numeric = 6 and (rls_test.st_line(rls_test.get('ias1'), 1) ->> 'dispatched')::numeric = 4
  and (rls_test.st_line(rls_test.get('ias1'), 1) ->> 'remaining')::numeric = 6 and rls_test.st_line(rls_test.get('ias1'), 1) ->> 'sales_order_number' is not null,
  rls_test.get('ias1')::text);
select rls_test.ok('7. two dispatches combine: FULLY_DISPATCHED 10 / 10, ready to post',
  rls_test.st_line(rls_test.get('ias2'), 1) ->> 'status' = 'FULLY_DISPATCHED' and (rls_test.st_line(rls_test.get('ias2'), 1) ->> 'dispatched')::numeric = 10
  and (rls_test.get('ias2') ->> 'ready')::boolean, rls_test.get('ias2')::text);
select rls_test.ok('11. the two dispatches deducted 10 once (100 -> 90)', rls_test.on_hand(rls_test.id('fg')) = 90);
select rls_test.set('tx1', to_jsonb(rls_test.tx_count(rls_test.id('company_a'))));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('6. full dispatch: post the invoice', 'iap', rls_test.issue(rls_test.gid('ia', 'invoice_id'), rls_test.id('k_post')));
select rls_test.expect_call_ok('12. the same post request again (retry)', 'iap2', rls_test.issue(rls_test.gid('ia', 'invoice_id'), rls_test.id('k_post')));
select rls_test.expect_call_error('12. a new post request for the posted invoice is refused', rls_test.issue(rls_test.gid('ia', 'invoice_id')), 'already issued');
reset role;
select rls_test.ok('6. invoice posted (ISSUED, numbered INV/...)',
  (rls_test.inv(rls_test.gid('ia', 'invoice_id'))).status = 'ISSUED' and rls_test.get('iap') ->> 'invoice_number' like 'INV/%', rls_test.get('iap')::text);
select rls_test.ok('17. the earlier failed posts did not consume an invoice number (first posted is .../0001)',
  rls_test.get('iap') ->> 'invoice_number' like '%/0001', rls_test.get('iap')::text);
select rls_test.ok('11. posting deducted no stock: still 90 on hand, no new ledger rows',
  rls_test.on_hand(rls_test.id('fg')) = 90 and rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx1'))::bigint);
select rls_test.ok('12. repeated request returns the first result: one ISSUED event, same number',
  (rls_test.get('iap2') ->> 'duplicate')::boolean and rls_test.get('iap2') ->> 'invoice_number' = rls_test.get('iap') ->> 'invoice_number'
  and rls_test.events(rls_test.gid('ia', 'invoice_id'), 'ISSUED') = 1, rls_test.get('iap2')::text);
select rls_test.ok('12. audit trail: the posted invoice has its billing event and the duplicate is logged',
  exists (select 1 from public.audit_logs where company_id = rls_test.id('company_a') and action = 'request.duplicate_returned'
          and metadata ->> 'operation' = 'sales_invoice_v2_issue'));

-- ---------------------------------------------------------------------------
-- 14. Reversal guard: a dispatch billed on a posted invoice cannot be reversed
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('14. reversing a dispatch already billed on posted invoice is refused',
  format('select public.sales_order_v2_reverse_dispatch(%L, %L, %L)', (rls_test.fulfilments(rls_test.gid('soa', 'sales_order_id')))[2], 'Wrong truck', gen_random_uuid()),
  'billed on posted invoice(s)');
reset role;
select rls_test.ok('14. refused reversal: stock still 90', rls_test.on_hand(rls_test.id('fg')) = 90);

-- ---------------------------------------------------------------------------
-- 4, 14. Reversed dispatch no longer counts; a replacement dispatch covers it
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('setup: order B for 5', 'sob', rls_test.so(rls_test.id('fg'), 5));
select rls_test.expect_call_ok('4. dispatch all 5', 'db1', rls_test.dispatch(rls_test.gid('sob', 'sales_order_id'), 5));
select rls_test.expect_call_ok('4. invoice 5 from order B (draft)', 'ib', rls_test.so_inv(rls_test.gid('sob', 'sales_order_id'), 5));
select rls_test.expect_call_ok('4. status: fully dispatched', 'ibs0', rls_test.status(rls_test.gid('ib', 'invoice_id')));
select rls_test.expect_call_ok('4. reverse the dispatch (invoice still a draft)', 'dbrev',
  format('select public.sales_order_v2_reverse_dispatch(%L, %L, %L)', (rls_test.fulfilments(rls_test.gid('sob', 'sales_order_id')))[1], 'Truck returned', gen_random_uuid()));
select rls_test.expect_call_ok('14. status after the reversal', 'ibs1', rls_test.status(rls_test.gid('ib', 'invoice_id')));
select rls_test.expect_call_error('4. posting against a reversed dispatch is refused', rls_test.issue(rls_test.gid('ib', 'invoice_id')), 'validly dispatched 0, still to dispatch 5');
select rls_test.expect_call_ok('4. replacement dispatch of 5', 'db2', rls_test.dispatch(rls_test.gid('sob', 'sales_order_id'), 5));
select rls_test.expect_call_ok('4. post after the replacement dispatch', 'ibp', rls_test.issue(rls_test.gid('ib', 'invoice_id')));
reset role;
select rls_test.ok('14. reversal lowers the valid dispatched quantity: 5 -> 0 (AWAITING_DISPATCH)',
  (rls_test.st_line(rls_test.get('ibs0'), 1) ->> 'dispatched')::numeric = 5
  and (rls_test.st_line(rls_test.get('ibs1'), 1) ->> 'dispatched')::numeric = 0 and rls_test.st_line(rls_test.get('ibs1'), 1) ->> 'status' = 'DISPATCH_ON_POSTING',
  rls_test.get('ibs1')::text);
select rls_test.ok('4. replacement dispatch covered the invoice; stock 90 - 5 = 85 (reversal restored, replacement deducted once)',
  (rls_test.inv(rls_test.gid('ib', 'invoice_id'))).status = 'ISSUED' and rls_test.on_hand(rls_test.id('fg')) = 85);

-- ---------------------------------------------------------------------------
-- 8, 9, 10. Service-only, mixed and charge lines
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('8. service-only invoice: installation + freight', 'isv',
  rls_test.save(jsonb_build_object('customer_id', rls_test.id('cx')), jsonb_build_array(rls_test.ln(rls_test.id('svc'), 2)), '{"freight": 150}'));
select rls_test.expect_call_ok('10. status of the service invoice', 'isvs', rls_test.status(rls_test.gid('isv', 'invoice_id')));
select rls_test.expect_call_ok('8. service-only invoice posts without any dispatch', 'isvp', rls_test.issue(rls_test.gid('isv', 'invoice_id')));
select rls_test.expect_call_ok('9. mixed manual invoice: installation + 3 basin mixers (not dispatched)', 'imx',
  rls_test.save(jsonb_build_object('customer_id', rls_test.id('cx')), jsonb_build_array(rls_test.ln(rls_test.id('svc'), 1), rls_test.ln(rls_test.id('fg'), 3))));
select rls_test.set('imxerr', rls_test.call(rls_test.issue(rls_test.gid('imx', 'invoice_id'))));
select rls_test.expect_call_ok('9. mixed invoice status', 'imxs', rls_test.status(rls_test.gid('imx', 'invoice_id')));
select rls_test.expect_call_ok('setup: order C for 2 basin mixers, fully dispatched', 'soc', rls_test.so(rls_test.id('fg'), 2));
select rls_test.expect_call_ok('setup: dispatch 2', 'dc1', rls_test.dispatch(rls_test.gid('soc', 'sales_order_id'), 2));
select rls_test.expect_call_ok('9. mixed order invoice: 2 dispatched mixers + packing charge', 'imc', rls_test.so_inv(rls_test.gid('soc', 'sales_order_id'), 2, '{"packing": 50}'));
select rls_test.expect_call_ok('9. mixed invoice with its goods dispatched posts', 'imcp', rls_test.issue(rls_test.gid('imc', 'invoice_id')));
reset role;
select rls_test.ok('8. service invoice ISSUED; no stock movement for the service', (rls_test.inv(rls_test.gid('isv', 'invoice_id'))).status = 'ISSUED'
  and rls_test.on_hand(rls_test.id('fg')) = 83);
select rls_test.ok('10. classification: non-stock product and charge line are NOT_APPLICABLE, invoice ready with 0 stock lines',
  rls_test.st_line(rls_test.get('isvs'), 1) ->> 'status' = 'NOT_APPLICABLE' and rls_test.st_line(rls_test.get('isvs'), 1) ->> 'reason' = 'Non-stock item'
  and rls_test.st_line(rls_test.get('isvs'), 2) ->> 'status' = 'NOT_APPLICABLE' and rls_test.st_line(rls_test.get('isvs'), 2) ->> 'reason' = 'Charge / service line'
  and (rls_test.get('isvs') ->> 'ready')::boolean and (rls_test.get('isvs') ->> 'stock_lines')::int = 0, rls_test.get('isvs')::text);
select rls_test.ok('9. mixed manual invoice refused for the goods only (the service is not listed)',
  rls_test.get('imxerr') ->> 'error' ilike '%DP-FG Basin mixer: invoiced 3%' and rls_test.get('imxerr') ->> 'error' not ilike '%DP-SVC%',
  rls_test.get('imxerr')::text);
select rls_test.ok('9. mixed status: service NOT_APPLICABLE, goods AWAITING_DISPATCH, 1 outstanding line',
  rls_test.st_line(rls_test.get('imxs'), 1) ->> 'status' = 'NOT_APPLICABLE' and rls_test.st_line(rls_test.get('imxs'), 2) ->> 'status' = 'AWAITING_DISPATCH'
  and (rls_test.get('imxs') ->> 'outstanding_lines')::int = 1);
select rls_test.ok('9. mixed order invoice (goods dispatched + packing charge) is ISSUED', (rls_test.inv(rls_test.gid('imc', 'invoice_id'))).status = 'ISSUED');

-- ---------------------------------------------------------------------------
-- 13. Concurrent / stale postings: a second invoice for the same dispatch is
-- re-checked under row locks inside the posting transaction. PGlite has one
-- connection, so a stale draft (validated before the first was posted) is
-- simulated by copying the posted invoice back to a draft.
-- ---------------------------------------------------------------------------
create function rls_test.clone_as_draft(p_id uuid) returns uuid language plpgsql security definer as $$
declare v_new uuid := gen_random_uuid();
begin
  insert into public.sales_invoices select (jsonb_populate_record(null::public.sales_invoices, to_jsonb(i)
    || jsonb_build_object('id', v_new, 'status', 'DRAFT', 'invoice_number', null, 'numbering_scope', null, 'financial_year', null,
                          'issued_at', null, 'issued_by', null, 'idempotency_key', null))).*
  from public.sales_invoices i where i.id = p_id;
  insert into public.sales_invoice_lines select (jsonb_populate_record(null::public.sales_invoice_lines, to_jsonb(l)
    || jsonb_build_object('id', gen_random_uuid(), 'invoice_id', v_new))).*
  from public.sales_invoice_lines l where l.invoice_id = p_id;
  return v_new;
end $$;
select rls_test.set('stale', rls_test.call(format('select to_jsonb(rls_test.clone_as_draft(%L))', rls_test.gid('imc', 'invoice_id'))));
select rls_test.ok('13. setup: a stale second draft for the same 2 dispatched mixers exists', not (rls_test.get('stale') ? 'error'), rls_test.get('stale')::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.set('staleerr', rls_test.call(rls_test.issue((rls_test.get('stale') #>> '{}')::uuid)));
reset role;
select rls_test.ok('13. posting the stale duplicate is refused (the 2 dispatched are already billed on a posted invoice)',
  rls_test.get('staleerr') ->> 'error' ilike any (array['%validly dispatched 0, still to dispatch 2%', '%only 0 of the sales order line is still to be invoiced%'])
  and (rls_test.inv((rls_test.get('stale') #>> '{}')::uuid)).status = 'DRAFT', rls_test.get('staleerr')::text);
select rls_test.ok('13. the guard runs inside the posting transaction (BEFORE UPDATE trigger on sales_invoices) and locks the order / dispatch lines',
  exists (select 1 from pg_trigger where tgname = 'sales_invoices_dispatch_guard' and tgrelid = 'public.sales_invoices'::regclass and not tgisinternal)
  and exists (select 1 from pg_trigger where tgname = 'fulfilment_lines_dispatch_reversal_guard')
  and pg_get_functiondef('private.invoice_dispatch_guard()'::regprocedure) ilike '%for update%');
select rls_test.ok('13. a direct status change also hits the rule (no path to ISSUED bypasses it)',
  (rls_test.call(format('update public.sales_invoices set status = ''ISSUED'' where id = %L returning jsonb_build_object(''id'', id)', (rls_test.get('stale') #>> '{}')::uuid))
    ->> 'error') ilike '%Dispatch the goods%');

-- ---------------------------------------------------------------------------
-- 16. Units and fractional quantities (KG)
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('16. order for 3.5 KG glaze powder', 'sok', rls_test.so(rls_test.id('kg'), 3.5));
select rls_test.expect_call_ok('16. dispatch 2.25 KG', 'dk1', rls_test.dispatch(rls_test.gid('sok', 'sales_order_id'), 2.25));
select rls_test.expect_call_ok('16. invoice 2.5 KG from the order', 'ik', rls_test.so_inv(rls_test.gid('sok', 'sales_order_id'), 2.5));
select rls_test.expect_call_error('16. 2.5 KG invoiced, 2.25 dispatched: refused with 0.25 KG remaining', rls_test.issue(rls_test.gid('ik', 'invoice_id')),
  'invoiced 2.5 KG, validly dispatched 2.25, still to dispatch 0.25');
select rls_test.expect_call_ok('16. dispatch 0.25 KG more', 'dk2', rls_test.dispatch(rls_test.gid('sok', 'sales_order_id'), 0.25));
select rls_test.expect_call_ok('16. post the 2.5 KG invoice', 'ikp', rls_test.issue(rls_test.gid('ik', 'invoice_id')));
reset role;
select rls_test.ok('16. fractional KG: posted after 2.25 + 0.25 dispatched; stock 20 - 2.5 = 17.5',
  (rls_test.inv(rls_test.gid('ik', 'invoice_id'))).status = 'ISSUED' and rls_test.on_hand(rls_test.id('kg')) = 17.5);

-- ---------------------------------------------------------------------------
-- 15. Company isolation; grants; historical exceptions report
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('b_op');
select rls_test.expect_call_error('15. company B cannot read company A''s invoice dispatch status', rls_test.status(rls_test.gid('ia', 'invoice_id')), 'not found');
select rls_test.expect_call_ok('15. company B exceptions report', 'bex', 'select public.invoice_dispatch_exceptions()');
select rls_test.expect_call_ok('15. company B: manual draft of its own product (same SKU as company A)', 'ibm',
  rls_test.save(jsonb_build_object('customer_id', rls_test.id('cb')), jsonb_build_array(rls_test.ln(rls_test.id('fgb'), 1))));
select rls_test.expect_call_error('15. company B''s undispatched invoice is refused too (A''s dispatches never count for B)',
  rls_test.issue(rls_test.gid('ibm', 'invoice_id')), 'still to dispatch 1');
select rls_test.expect_call_error('15. company B cannot post company A''s draft', rls_test.issue(rls_test.gid('m1', 'invoice_id'), gen_random_uuid()));
reset role;
select rls_test.ok('15. company B sees no company A exceptions', jsonb_array_length(rls_test.get('bex') -> 'rows') = 0, rls_test.get('bex')::text);
select rls_test.ok('grants: anon cannot call the status / exceptions RPCs; the private helpers are not callable by clients',
  not has_function_privilege('anon', 'public.invoice_dispatch_status(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.invoice_dispatch_exceptions()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.invoice_dispatch_lines(uuid)', 'EXECUTE'));

-- Historical exception: an invoice posted before the rule existed (simulated by
-- owner-side posting with the trigger disabled) is listed, never changed.
do $$
begin
  alter table public.sales_invoices disable trigger sales_invoices_dispatch_guard;
  update public.sales_invoices set status = 'ISSUED', invoice_number = 'OLD/0001', issued_at = now(), issued_by = rls_test.id('op') where id = rls_test.gid('m1', 'invoice_id');
  alter table public.sales_invoices enable trigger sales_invoices_dispatch_guard;
end $$;
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('historical: exceptions report', 'aex', 'select public.invoice_dispatch_exceptions()');
reset role;
select rls_test.ok('historical: the pre-rule invoice is listed (5 uncovered) and left ISSUED; properly dispatched invoices are not listed',
  jsonb_array_length(rls_test.get('aex') -> 'rows') = 1 and rls_test.get('aex') -> 'rows' -> 0 ->> 'invoice_number' = 'OLD/0001'
  and (rls_test.get('aex') -> 'rows' -> 0 ->> 'uncovered')::numeric = 5 and (rls_test.inv(rls_test.gid('m1', 'invoice_id'))).status = 'ISSUED',
  rls_test.get('aex')::text);

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
  raise exception 'INVOICE_DISPATCH_POLICY_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
