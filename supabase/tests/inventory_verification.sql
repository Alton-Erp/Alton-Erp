-- =============================================================================
-- INVENTORY (PHASE 4) VERIFICATION
--
-- Executable checks for the stock ledger, balances, reservations, transfers,
-- reversals, approvals (segregation of duties), counts, historical stock,
-- alerts, RLS and cross-company isolation.
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction with its own test companies (INVA / INVB) and users
-- (@example.invalid), and ALWAYS ends by raising
--   INVENTORY_VERIFICATION_RESULT passed=N failed=M
-- so that every test row is rolled back. failed=0 means all checks passed.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Harness
-- ---------------------------------------------------------------------------
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
-- Executes SQL returning jsonb; errors are captured (and rolled back) instead of aborting.
create function rls_test.call(p_sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin execute p_sql into r; return coalesce(r, '{}'::jsonb);
exception when others then return jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate); end $$;
create function rls_test.set(p_key text, p_value jsonb) returns jsonb language plpgsql as $$
begin insert into rls_test.vars values (p_key, p_value) on conflict (key) do update set value = excluded.value; return p_value; end $$;
create function rls_test.get(p_key text) returns jsonb language sql stable as $$ select value from rls_test.vars where key = p_key $$;
create function rls_test.expect_rows(p_name text, p_sql text, p_expected int) returns void language plpgsql as $$
declare n int;
begin execute format('select count(*) from (%s) q', p_sql) into n;
  perform rls_test.ok(p_name, n = p_expected, format('rows=%s expected=%s', n, p_expected));
exception when others then perform rls_test.ok(p_name, false, format('unexpected error %s: %s', sqlstate, sqlerrm)); end $$;
create function rls_test.expect_affected(p_name text, p_sql text, p_expected int) returns void language plpgsql as $$
declare n int;
begin execute p_sql; get diagnostics n = row_count;
  perform rls_test.ok(p_name, n = p_expected, format('affected=%s expected=%s', n, p_expected));
exception when others then perform rls_test.ok(p_name, false, format('unexpected error %s: %s', sqlstate, sqlerrm)); end $$;
create function rls_test.expect_error(p_name text, p_sql text) returns void language plpgsql as $$
begin execute p_sql; perform rls_test.ok(p_name, false, 'statement succeeded but should have been rejected');
exception when others then perform rls_test.ok(p_name, true, format('rejected %s: %s', sqlstate, sqlerrm)); end $$;
-- Passes when an RPC call returns successfully (no error key).
create function rls_test.expect_call_ok(p_name text, p_key text, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.set(p_key, r); perform rls_test.ok(p_name, not (r ? 'error'), r::text); return r; end $$;
create function rls_test.expect_call_error(p_name text, p_sql text, p_pattern text default null) returns void language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.ok(p_name, r ? 'error' and (p_pattern is null or r ->> 'error' ilike '%' || p_pattern || '%'), r::text); end $$;
create function rls_test.claims(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', rls_test.id(p_key), 'role', 'authenticated')::text, true) $$;

-- Owner-side probes (bypass RLS) used to assert actual stored state.
create function rls_test.on_hand(p_product uuid, p_location uuid default null, p_source text default null) returns numeric
language sql stable security definer as $$
  select coalesce(sum(on_hand), 0) from public.inventory_balances
  where product_id = p_product and (p_location is null or location_id = p_location) and (p_source is null or source_type = p_source) $$;
create function rls_test.reserved(p_product uuid, p_location uuid default null, p_source text default null) returns numeric
language sql stable security definer as $$
  select coalesce(sum(reserved), 0) from public.inventory_balances
  where product_id = p_product and (p_location is null or location_id = p_location) and (p_source is null or source_type = p_source) $$;
create function rls_test.ledger_count(p_product uuid, p_type text default null) returns bigint
language sql stable security definer as $$
  select count(*) from public.inventory_transactions where product_id = p_product and (p_type is null or transaction_type = p_type) $$;
create function rls_test.today() returns date language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;

grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures (database owner)
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e57100-0000-4000-8000-0000000000a1'), ('company_b', 'e7e57100-0000-4000-8000-0000000000b1'),
  ('im',     'e7e57100-0000-4000-8000-000000000002'),  -- Inventory Manager A (requester)
  ('im2',    'e7e57100-0000-4000-8000-000000000003'),  -- Inventory Manager A (approver)
  ('adm',    'e7e57100-0000-4000-8000-000000000004'),  -- Admin A
  ('sales',  'e7e57100-0000-4000-8000-000000000005'),  -- Sales Manager A (reservations)
  ('viewer', 'e7e57100-0000-4000-8000-000000000006'),  -- Management Viewer A
  ('prod',   'e7e57100-0000-4000-8000-000000000007'),  -- Production Manager A (read only)
  ('b_im',   'e7e57100-0000-4000-8000-000000000008'),  -- Inventory Manager B
  ('p_pcs',  'e7e57100-0000-4000-8000-0000000000d1'), ('p_bat', 'e7e57100-0000-4000-8000-0000000000d2'),
  ('p_kg',   'e7e57100-0000-4000-8000-0000000000d3'), ('p_b',   'e7e57100-0000-4000-8000-0000000000d4'),
  ('w1',     'e7e57100-0000-4000-8000-0000000000e1'), ('w2',    'e7e57100-0000-4000-8000-0000000000e2'),
  ('wb',     'e7e57100-0000-4000-8000-0000000000e3'),
  ('bin1',   'e7e57100-0000-4000-8000-0000000000f1'), ('old',   'e7e57100-0000-4000-8000-0000000000f2');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code) values
  (rls_test.id('company_a'), 'Inventory Test A', 'Inventory Test A', 'INVA'),
  (rls_test.id('company_b'), 'Inventory Test B', 'Inventory Test B', 'INVB');
-- V2 turns segregation of duties off by default (single operator). This suite tests it, so it switches it on.
insert into public.company_settings (company_id, setting_key, setting_value)
select id, 'inventory.segregation_of_duties', 'true'::jsonb from public.companies where id in (rls_test.id('company_a'), rls_test.id('company_b'));

insert into auth.users (id, email)
select id, key || '@inv.example.invalid' from rls_test.ids where key in ('im', 'im2', 'adm', 'sales', 'viewer', 'prod', 'b_im');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true
  where id in (rls_test.id('im'), rls_test.id('im2'), rls_test.id('adm'), rls_test.id('sales'), rls_test.id('viewer'), rls_test.id('prod'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_im');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('im'),     rls_test.id('company_a'), rls_test.id('role_inventory_manager')),
  (rls_test.id('im2'),    rls_test.id('company_a'), rls_test.id('role_inventory_manager')),
  (rls_test.id('adm'),    rls_test.id('company_a'), rls_test.id('role_admin')),
  (rls_test.id('sales'),  rls_test.id('company_a'), rls_test.id('role_sales_manager')),
  (rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_management_viewer')),
  (rls_test.id('prod'),   rls_test.id('company_a'), rls_test.id('role_production_manager')),
  (rls_test.id('b_im'),   rls_test.id('company_b'), rls_test.id('role_inventory_manager'));

insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, reorder_level, track_batches, track_expiry) values
  (rls_test.id('p_pcs'), rls_test.id('company_a'), 'INV-PCS', 'Hybrid basin',     'FINISHED_GOOD', 'HYBRID',     'PCS', 10,   false, false),
  (rls_test.id('p_bat'), rls_test.id('company_a'), 'INV-BAT', 'Batch sealant',    'RAW_MATERIAL',  'OUTSOURCED', 'BOX', null, true,  true),
  (rls_test.id('p_kg'),  rls_test.id('company_a'), 'INV-KG',  'Glaze powder',     'RAW_MATERIAL',  'HYBRID',     'KG',  null, false, false),
  (rls_test.id('p_b'),   rls_test.id('company_b'), 'INV-PCS', 'Company B product','FINISHED_GOOD', 'IN_HOUSE',   'PCS', null, false, false);
-- Opening stock is priced at the Product Master Cost (migration 20261129090000): the products get the cost the lines used before.
update public.products set standard_cost = case id when rls_test.id('p_pcs') then 50 when rls_test.id('p_bat') then 10 else 8 end,
  change_reason = 'test: Product Master Cost for opening stock' where id in (rls_test.id('p_pcs'), rls_test.id('p_bat'), rls_test.id('p_kg'));

insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Test main store', true),
  (rls_test.id('w2'), rls_test.id('company_a'), 'W2', 'Test second store', false),
  (rls_test.id('wb'), rls_test.id('company_b'), 'W1', 'Company B store', true);
insert into public.inventory_locations (id, company_id, warehouse_id, location_code, location_name, location_type) values
  (rls_test.id('bin1'), rls_test.id('company_a'), rls_test.id('w1'), 'BIN-1', 'Bin 1', 'BIN'),
  (rls_test.id('old'),  rls_test.id('company_a'), rls_test.id('w1'), 'OLD', 'Old bay', 'AREA');
update public.inventory_locations set status = 'INACTIVE' where id = rls_test.id('old');
insert into rls_test.ids (key, id)
select case warehouse_id when rls_test.id('w1') then 'g1' when rls_test.id('w2') then 'g2' else 'gb' end, id
from public.inventory_locations where location_code = 'GENERAL' and warehouse_id in (rls_test.id('w1'), rls_test.id('w2'), rls_test.id('wb'));

select rls_test.ok('every warehouse gets an automatic default GENERAL location',
  (select count(*) = 3 from public.inventory_locations where location_code = 'GENERAL' and is_default
   and warehouse_id in (rls_test.id('w1'), rls_test.id('w2'), rls_test.id('wb'))));
select rls_test.ok('RLS enabled on every inventory table',
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity));
select rls_test.ok('clients have no write privileges on ledger, balances, batches, reservations or documents',
  not exists (select 1 from unnest(array['inventory_transactions', 'inventory_balances', 'inventory_batches', 'stock_reservations',
      'inventory_opening_batches', 'inventory_opening_lines', 'inventory_adjustments', 'inventory_counts', 'inventory_count_lines',
      'inventory_alerts', 'inventory_requests', 'inventory_number_sequences']) t
    where has_table_privilege('authenticated', 'public.' || t, 'INSERT,UPDATE,DELETE')));
select rls_test.ok('products table still has no stock columns',
  not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'products'
              and column_name ~ '(stock|qty|quantity|on_hand|available|reserved|balance)'));

-- ===========================================================================
-- OPENING STOCK
-- ===========================================================================
select rls_test.set('opening_lines', jsonb_build_array(
  jsonb_build_object('line_no', 1, 'product_id', rls_test.id('p_pcs'), 'location_id', rls_test.id('g1'), 'source_type', 'IN_HOUSE',
    'quantity', 100, 'unit_cost', 50, 'effective_date', rls_test.today() - 10),
  jsonb_build_object('line_no', 2, 'product_id', rls_test.id('p_pcs'), 'location_id', rls_test.id('g1'), 'source_type', 'OUTSOURCED',
    'quantity', 40, 'unit_cost', 60, 'effective_date', rls_test.today() - 10),
  jsonb_build_object('line_no', 3, 'product_id', rls_test.id('p_bat'), 'location_id', rls_test.id('g1'), 'source_type', 'OUTSOURCED',
    'batch_number', 'B-001', 'manufacturing_date', rls_test.today() - 100, 'expiry_date', rls_test.today() + 20,
    'quantity', 30, 'unit_cost', 10, 'effective_date', rls_test.today() - 10),
  jsonb_build_object('line_no', 4, 'product_id', rls_test.id('p_kg'), 'location_id', rls_test.id('g1'), 'source_type', 'UNKNOWN',
    'quantity', 12.5, 'effective_date', rls_test.today() - 10)));

set local role authenticated;
select rls_test.claims('sales');
select rls_test.expect_call_error('opening: Sales Manager cannot submit opening stock',
  format($q$ select public.inventory_submit_opening_stock_at_cost(%L::jsonb, 'MANUAL', null, null, gen_random_uuid()) $q$, rls_test.get('opening_lines')), 'not allowed');
select rls_test.claims('viewer');
select rls_test.expect_call_error('opening: Management Viewer cannot submit opening stock',
  format($q$ select public.inventory_submit_opening_stock_at_cost(%L::jsonb, 'MANUAL', null, null, gen_random_uuid()) $q$, rls_test.get('opening_lines')), 'not allowed');

select rls_test.claims('im');
-- Direct calls to the functions without Product Master pricing are refused (migration 20261130090000).
select rls_test.expect_call_error('opening: the legacy submit function cannot be called directly (no bypass of Product Master pricing)',
  format($q$ select public.inventory_submit_opening_stock(%L::jsonb, 'MANUAL', null, null, gen_random_uuid()) $q$, rls_test.get('opening_lines')), 'permission denied');
select rls_test.expect_call_error('opening: the legacy one-step function cannot be called directly either',
  format($q$ select public.inventory_post_opening_stock(%L::jsonb, 'MANUAL', null, null, gen_random_uuid()) $q$, rls_test.get('opening_lines')), 'permission denied');
-- A batch with an invalid row stages NOTHING.
select rls_test.set('bad_import', rls_test.call(format($q$ select public.inventory_submit_opening_stock_at_cost(%L::jsonb, 'IMPORT', 'test.xlsx', null, gen_random_uuid()) $q$,
  jsonb_build_array(
    jsonb_build_object('line_no', 2, 'product_id', rls_test.id('p_kg'), 'location_id', rls_test.id('g1'), 'source_type', 'OUTSOURCED', 'quantity', 5, 'effective_date', rls_test.today()),
    jsonb_build_object('line_no', 3, 'product_id', rls_test.id('p_kg'), 'location_id', rls_test.id('g1'), 'source_type', 'IN_HOUSE', 'quantity', -1, 'effective_date', rls_test.today()),
    jsonb_build_object('line_no', 4, 'product_id', rls_test.id('p_kg'), 'location_id', rls_test.id('g2'), 'source_type', 'IN_HOUSE', 'quantity', 1, 'effective_date', rls_test.today() + 1),
    jsonb_build_object('line_no', 5, 'product_id', rls_test.id('p_bat'), 'location_id', rls_test.id('g1'), 'source_type', 'IN_HOUSE', 'quantity', 1, 'effective_date', rls_test.today()),
    jsonb_build_object('line_no', 6, 'product_id', rls_test.id('p_kg'), 'location_id', rls_test.id('old'), 'source_type', 'IN_HOUSE', 'quantity', 1, 'effective_date', rls_test.today()),
    jsonb_build_object('line_no', 7, 'product_id', rls_test.id('p_kg'), 'location_id', rls_test.id('g1'), 'source_type', 'OUTSOURCED', 'quantity', 2, 'effective_date', rls_test.today()),
    jsonb_build_object('line_no', 8, 'product_id', rls_test.id('p_kg'), 'location_id', rls_test.id('g1'), 'source_type', 'IN_HOUSE', 'quantity', 1, 'unit', 'PCS', 'effective_date', rls_test.today())
  ))));
select rls_test.ok('opening import: invalid rows are rejected with row numbers and nothing is staged',
  (rls_test.get('bad_import') ->> 'ok') = 'false'
  and jsonb_array_length(rls_test.get('bad_import') -> 'errors') = 6
  and (select count(*) = 0 from public.inventory_opening_batches where company_id = rls_test.id('company_a')),
  rls_test.get('bad_import')::text);
select rls_test.ok('opening import: error rows identify quantity, future date, batch, inactive location, duplicate and unit problems',
  (select string_agg(e ->> 'line_no', ',' order by (e ->> 'line_no')::int) from jsonb_array_elements(rls_test.get('bad_import') -> 'errors') e) = '3,4,5,6,7,8',
  rls_test.get('bad_import')::text);

select rls_test.expect_call_ok('opening: Inventory Manager submits opening stock for approval', 'open1',
  format($q$ select public.inventory_submit_opening_stock_at_cost(%L::jsonb, 'MANUAL', null, 'Initial count', 'e7e5f000-0000-4000-8000-000000000001') $q$, rls_test.get('opening_lines')));
select rls_test.ok('opening: submission is staged (pending), not posted', (rls_test.get('open1') ->> 'ok') = 'true'
  and rls_test.on_hand(rls_test.id('p_pcs')) = 0 and rls_test.ledger_count(rls_test.id('p_pcs')) = 0);
select rls_test.ok('opening: staged lines carry the Product Master Cost, not the costs sent (50 / 50 / 10 / 8; line 2 sent 60)',
  (select string_agg(unit_cost::numeric::text, ',' order by line_no) from public.inventory_opening_lines
   where opening_batch_id = (rls_test.get('open1') ->> 'opening_batch_id')::uuid) = '50.0000,50.0000,10.0000,8.0000');
select rls_test.set('open1_dup', rls_test.call(format($q$ select public.inventory_submit_opening_stock_at_cost(%L::jsonb, 'MANUAL', null, null, 'e7e5f000-0000-4000-8000-000000000001') $q$,
  rls_test.get('opening_lines'))));
select rls_test.ok('opening: retry with the same request id returns the same document (no duplicate)',
  (rls_test.get('open1_dup') ->> 'duplicate') = 'true'
  and rls_test.get('open1_dup') ->> 'document_number' = rls_test.get('open1') ->> 'document_number');
select rls_test.set('open1_again', rls_test.call(format($q$ select public.inventory_submit_opening_stock_at_cost(%L::jsonb, 'MANUAL', null, null, gen_random_uuid()) $q$,
  rls_test.get('opening_lines'))));
select rls_test.ok('opening: re-submitting the same opening balances is rejected as duplicate',
  (rls_test.get('open1_again') ->> 'ok') = 'false' and rls_test.get('open1_again')::text ilike '%already exists%', rls_test.get('open1_again')::text);
select rls_test.expect_call_error('opening: requester cannot approve own submission (segregation of duties)',
  format($q$ select public.inventory_review_opening_stock(%L, 'APPROVE', null, gen_random_uuid()) $q$, rls_test.get('open1') ->> 'opening_batch_id'), 'Segregation');
select rls_test.claims('sales');
select rls_test.expect_call_error('opening: user without approval permission cannot approve',
  format($q$ select public.inventory_review_opening_stock(%L, 'APPROVE', null, gen_random_uuid()) $q$, rls_test.get('open1') ->> 'opening_batch_id'), 'not allowed');
select rls_test.claims('im2');
select rls_test.expect_call_ok('opening: second Inventory Manager approves and posts', 'open1_review',
  format($q$ select public.inventory_review_opening_stock(%L, 'APPROVE', 'Checked', 'e7e5f000-0000-4000-8000-000000000002') $q$, rls_test.get('open1') ->> 'opening_batch_id'));
select rls_test.ok('opening: approval posts OPENING_STOCK entries and balances by source',
  rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 100
  and rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g1'), 'OUTSOURCED') = 40
  and rls_test.on_hand(rls_test.id('p_bat')) = 30 and rls_test.on_hand(rls_test.id('p_kg'), null, 'UNKNOWN') = 12.5
  and rls_test.ledger_count(rls_test.id('p_pcs'), 'OPENING_STOCK') = 2);
select rls_test.expect_call_error('opening: an approved document cannot be posted twice',
  format($q$ select public.inventory_review_opening_stock(%L, 'APPROVE', null, gen_random_uuid()) $q$, rls_test.get('open1') ->> 'opening_batch_id'), 'already');
select rls_test.ok('opening: hybrid product holds stock from both sources',
  rls_test.on_hand(rls_test.id('p_pcs'), null, 'IN_HOUSE') > 0 and rls_test.on_hand(rls_test.id('p_pcs'), null, 'OUTSOURCED') > 0);

-- ===========================================================================
-- RECEIPTS AND ISSUES
-- ===========================================================================
select rls_test.claims('im');
select rls_test.expect_call_ok('receipt: increases on-hand stock', 'r1',
  format($q$ select public.inventory_post_receipt(%L, %L, 20, 'IN_HOUSE', p_unit_cost => 55, p_reference_number => 'GRN-1', p_idempotency_key => 'e7e5f000-0000-4000-8000-000000000003') $q$,
  rls_test.id('p_pcs'), rls_test.id('g1')));
select rls_test.ok('receipt: in-house stock is now 120', rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 120);
select rls_test.set('r1_dup', rls_test.call(format($q$ select public.inventory_post_receipt(%L, %L, 20, 'IN_HOUSE', p_unit_cost => 55, p_idempotency_key => 'e7e5f000-0000-4000-8000-000000000003') $q$,
  rls_test.id('p_pcs'), rls_test.id('g1'))));
select rls_test.ok('receipt: double submit with the same request id posts only once',
  (rls_test.get('r1_dup') ->> 'duplicate') = 'true' and rls_test.ledger_count(rls_test.id('p_pcs'), 'RECEIPT') = 1
  and rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 120);
select rls_test.expect_call_error('receipt: request without a request id is rejected',
  format($q$ select public.inventory_post_receipt(%L, %L, 1, 'IN_HOUSE') $q$, rls_test.id('p_pcs'), rls_test.id('g1')), 'request id');
select rls_test.expect_call_error('receipt: unknown source is not allowed for receipts',
  format($q$ select public.inventory_post_receipt(%L, %L, 1, 'UNKNOWN', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('p_pcs'), rls_test.id('g1')), 'UNKNOWN');
select rls_test.expect_call_error('receipt: batch-tracked product requires a batch number',
  format($q$ select public.inventory_post_receipt(%L, %L, 1, 'OUTSOURCED', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('p_bat'), rls_test.id('g1')), 'batch');
select rls_test.expect_call_error('receipt: inactive location is rejected',
  format($q$ select public.inventory_post_receipt(%L, %L, 1, 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('p_pcs'), rls_test.id('old')), 'inactive');
select rls_test.expect_call_error('receipt: negative quantity is rejected',
  format($q$ select public.inventory_post_receipt(%L, %L, -5, 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('p_pcs'), rls_test.id('g1')), 'greater than zero');

select rls_test.expect_call_ok('issue: decreases on-hand stock', 'i1',
  format($q$ select public.inventory_post_issue(%L, %L, 10, p_source_type => 'IN_HOUSE', p_reason => 'Sample issue', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('p_pcs'), rls_test.id('g1')));
select rls_test.ok('issue: in-house stock is now 110', rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 110);
select rls_test.expect_call_error('issue: must choose the source when a location holds both',
  format($q$ select public.inventory_post_issue(%L, %L, 1, p_reason => 'x', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('p_pcs'), rls_test.id('g1')), 'more than one source');
select rls_test.expect_call_error('issue: over-issuing is rejected (no negative stock)',
  format($q$ select public.inventory_post_issue(%L, %L, 1000, p_source_type => 'IN_HOUSE', p_reason => 'x', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('p_pcs'), rls_test.id('g1')), 'Insufficient');
select rls_test.ok('issue: failed over-issue left stock unchanged', rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 110);

-- ===========================================================================
-- RESERVATIONS
-- ===========================================================================
select rls_test.claims('sales');
select rls_test.expect_call_ok('reservation: Sales Manager reserves 30', 'res1',
  format($q$ select public.inventory_create_reservation(%L, %L, 30, 'SALES_ORDER', 'SO-TEST-1', p_source_type => 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('p_pcs'), rls_test.id('g1')));
select rls_test.ok('reservation: reduces available, not on-hand',
  rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 110 and rls_test.reserved(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 30);
select rls_test.expect_call_error('reservation: over-reservation (81 of 80 available) is rejected',
  format($q$ select public.inventory_create_reservation(%L, %L, 81, 'SALES_ORDER', 'SO-TEST-2', p_source_type => 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('p_pcs'), rls_test.id('g1')), 'only');
select rls_test.expect_call_ok('reservation: the remaining 80 can be reserved', 'res2',
  format($q$ select public.inventory_create_reservation(%L, %L, 80, 'SALES_ORDER', 'SO-TEST-2', p_source_type => 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('p_pcs'), rls_test.id('g1')));
select rls_test.expect_call_error('reservation: a further reservation cannot allocate the same units',
  format($q$ select public.inventory_create_reservation(%L, %L, 1, 'SALES_ORDER', 'SO-TEST-3', p_source_type => 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('p_pcs'), rls_test.id('g1')), 'only');
select rls_test.expect_call_ok('reservation: release', 'rel2',
  format($q$ select public.inventory_release_reservation(%L, 'RELEASE', 'Order cancelled') $q$, rls_test.get('res2') ->> 'reservation_id'));
select rls_test.ok('reservation: release restores available stock',
  rls_test.reserved(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 30
  and (select reservation_status = 'RELEASED' from public.stock_reservations where id = (rls_test.get('res2') ->> 'reservation_id')::uuid));
select rls_test.expect_call_error('reservation: a released reservation cannot be released again',
  format($q$ select public.inventory_release_reservation(%L, 'RELEASE') $q$, rls_test.get('res2') ->> 'reservation_id'), 'already');
select rls_test.claims('im');
select rls_test.expect_call_error('issue: reserved stock cannot be issued as free stock (85 requested, 80 available)',
  format($q$ select public.inventory_post_issue(%L, %L, 85, p_source_type => 'IN_HOUSE', p_reason => 'x', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('p_pcs'), rls_test.id('g1')), 'Insufficient');
select rls_test.expect_call_ok('reservation: partial fulfilment issues stock', 'ful1',
  format($q$ select public.inventory_fulfil_reservation(%L, 10, p_idempotency_key => gen_random_uuid()) $q$, rls_test.get('res1') ->> 'reservation_id'));
select rls_test.ok('reservation: partial fulfilment reduces on-hand and reserved together',
  rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 100 and rls_test.reserved(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 20
  and (select reservation_status = 'PARTIALLY_FULFILLED' from public.stock_reservations where id = (rls_test.get('res1') ->> 'reservation_id')::uuid));
select rls_test.expect_call_ok('reservation: final fulfilment', 'ful2',
  format($q$ select public.inventory_fulfil_reservation(%L, 20, p_idempotency_key => gen_random_uuid()) $q$, rls_test.get('res1') ->> 'reservation_id'));
select rls_test.ok('reservation: fully fulfilled, nothing left reserved',
  rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 80 and rls_test.reserved(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 0
  and (select reservation_status = 'FULFILLED' from public.stock_reservations where id = (rls_test.get('res1') ->> 'reservation_id')::uuid));
select rls_test.expect_call_error('reservation: cannot fulfil more than reserved',
  format($q$ select public.inventory_fulfil_reservation(%L, 1, p_idempotency_key => gen_random_uuid()) $q$, rls_test.get('res1') ->> 'reservation_id'), 'FULFILLED');

-- ===========================================================================
-- TRANSFERS
-- ===========================================================================
select rls_test.expect_call_ok('transfer: move 30 in-house units W1 -> W2', 't1',
  format($q$ select public.inventory_transfer_stock(%L, %L, %L, 30, p_source_type => 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('p_pcs'), rls_test.id('g1'), rls_test.id('g2')));
select rls_test.ok('transfer: source decreases, destination increases, company total unchanged',
  rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 50 and rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g2'), 'IN_HOUSE') = 30
  and rls_test.on_hand(rls_test.id('p_pcs'), null, 'IN_HOUSE') = 80);
select rls_test.ok('transfer: same lot and source on both sides (attribution preserved)',
  (select count(distinct batch_id) = 1 and bool_and(source_type = 'IN_HOUSE') from public.inventory_balances
   where product_id = rls_test.id('p_pcs') and source_type = 'IN_HOUSE' and on_hand > 0));
select rls_test.ok('transfer: paired TRANSFER_OUT and TRANSFER_IN share one group',
  (select count(*) = 2 and count(distinct transfer_group_id) = 1 from public.inventory_transactions
   where product_id = rls_test.id('p_pcs') and transaction_type in ('TRANSFER_OUT', 'TRANSFER_IN')));
select rls_test.expect_call_error('transfer: to an inactive location is rejected',
  format($q$ select public.inventory_transfer_stock(%L, %L, %L, 5, p_source_type => 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('p_pcs'), rls_test.id('g1'), rls_test.id('old')), 'inactive');
select rls_test.expect_call_error('transfer: more than available is rejected',
  format($q$ select public.inventory_transfer_stock(%L, %L, %L, 1000, p_source_type => 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('p_pcs'), rls_test.id('g1'), rls_test.id('g2')), 'Insufficient');
select rls_test.ok('transfer: failed transfers rolled back completely (no half-posted legs)',
  rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 50 and rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g2'), 'IN_HOUSE') = 30
  and rls_test.ledger_count(rls_test.id('p_pcs'), 'TRANSFER_OUT') = 1 and rls_test.ledger_count(rls_test.id('p_pcs'), 'TRANSFER_IN') = 1);
select rls_test.claims('sales');
select rls_test.expect_call_error('transfer: user without transfer permission is rejected',
  format($q$ select public.inventory_transfer_stock(%L, %L, %L, 1, p_source_type => 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('p_pcs'), rls_test.id('g1'), rls_test.id('g2')), 'not allowed');

-- ===========================================================================
-- REVERSALS
-- ===========================================================================
select rls_test.expect_call_error('reversal: user without approval permission cannot reverse',
  format($q$ select public.inventory_reverse_transaction(%L, 'Wrong entry', gen_random_uuid()) $q$, rls_test.get('r1') ->> 'transaction_id'), 'not allowed');
select rls_test.claims('im');
select rls_test.expect_call_ok('reversal: receipt is corrected by a reversal entry', 'rev1',
  format($q$ select public.inventory_reverse_transaction(%L, 'Received in error', gen_random_uuid()) $q$, rls_test.get('r1') ->> 'transaction_id'));
select rls_test.ok('reversal: original kept, reversal added, balance recalculated',
  (select count(*) = 1 from public.inventory_transactions where id = (rls_test.get('r1') ->> 'transaction_id')::uuid)
  and rls_test.ledger_count(rls_test.id('p_pcs'), 'REVERSAL') = 1
  and rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 30);
select rls_test.expect_call_error('reversal: cannot reverse the same transaction twice',
  format($q$ select public.inventory_reverse_transaction(%L, 'Again', gen_random_uuid()) $q$, rls_test.get('r1') ->> 'transaction_id'), 'already');
select rls_test.expect_call_error('reversal: a reversal cannot be reversed',
  format($q$ select public.inventory_reverse_transaction(id, 'Again', gen_random_uuid()) from public.inventory_transactions where reversal_of_transaction_id = %L $q$,
  rls_test.get('r1') ->> 'transaction_id'), 'cannot itself');
select rls_test.expect_call_ok('reversal: a transfer is reversed as a pair', 'rev_t1',
  format($q$ select public.inventory_reverse_transaction(id, 'Wrong destination', gen_random_uuid()) from public.inventory_transactions
             where transaction_type = 'TRANSFER_OUT' and product_id = %L $q$, rls_test.id('p_pcs')));
select rls_test.ok('reversal: both transfer legs reversed and stock back at the source',
  rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 60 and rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g2'), 'IN_HOUSE') = 0
  and rls_test.ledger_count(rls_test.id('p_pcs'), 'REVERSAL') = 3);

-- ===========================================================================
-- ADJUSTMENTS AND APPROVALS
-- ===========================================================================
select rls_test.claims('viewer');
select rls_test.expect_call_error('adjustment: Management Viewer cannot request adjustments',
  format($q$ select public.inventory_create_adjustment('QUANTITY', %L, %L, 'DAMAGE', p_source_type => 'IN_HOUSE', p_counted_quantity => 55, p_notes => 'x', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('p_pcs'), rls_test.id('g1')), 'not allowed');
select rls_test.claims('im');
select rls_test.expect_call_ok('adjustment: request (60 -> 55, damage)', 'a1',
  format($q$ select public.inventory_create_adjustment('QUANTITY', %L, %L, 'DAMAGE', p_source_type => 'IN_HOUSE', p_counted_quantity => 55, p_notes => 'Broken in handling', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('p_pcs'), rls_test.id('g1')));
select rls_test.ok('adjustment: pending request does not change stock',
  rls_test.get('a1') ->> 'status' = 'PENDING_APPROVAL' and rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 60
  and (select system_quantity = 60 and difference = -5 from public.inventory_adjustments where id = (rls_test.get('a1') ->> 'adjustment_id')::uuid));
select rls_test.expect_call_error('adjustment: requester cannot approve own adjustment',
  format($q$ select public.inventory_review_adjustment(%L, 'APPROVE', null, gen_random_uuid()) $q$, rls_test.get('a1') ->> 'adjustment_id'), 'Segregation');
select rls_test.claims('prod');
select rls_test.expect_call_error('adjustment: Production Manager cannot approve adjustments',
  format($q$ select public.inventory_review_adjustment(%L, 'APPROVE', null, gen_random_uuid()) $q$, rls_test.get('a1') ->> 'adjustment_id'), 'not allowed');
select rls_test.claims('im2');
select rls_test.expect_call_ok('adjustment: independent approver approves and posts', 'a1_review',
  format($q$ select public.inventory_review_adjustment(%L, 'APPROVE', 'Verified', gen_random_uuid()) $q$, rls_test.get('a1') ->> 'adjustment_id'));
select rls_test.ok('adjustment: posted as ADJUSTMENT_OUT of 5',
  rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 55 and rls_test.ledger_count(rls_test.id('p_pcs'), 'ADJUSTMENT_OUT') = 1
  and (select status = 'POSTED' and reviewed_by = rls_test.id('im2') from public.inventory_adjustments where id = (rls_test.get('a1') ->> 'adjustment_id')::uuid));
select rls_test.expect_call_error('adjustment: cannot be posted twice',
  format($q$ select public.inventory_review_adjustment(%L, 'APPROVE', null, gen_random_uuid()) $q$, rls_test.get('a1') ->> 'adjustment_id'), 'only pending');

-- Source attribution correction (UNKNOWN legacy stock -> IN_HOUSE)
select rls_test.claims('im');
select rls_test.expect_call_ok('source correction: requested for unverified stock', 'a2',
  format($q$ select public.inventory_create_adjustment('SOURCE_CORRECTION', %L, %L, 'SOURCE_CORRECTION', p_source_type => 'UNKNOWN', p_correction_quantity => 12.5,
             p_target_source_type => 'IN_HOUSE', p_notes => 'Production records confirm in-house manufacture', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('p_kg'), rls_test.id('g1')));
select rls_test.claims('im2');
select rls_test.expect_call_ok('source correction: approved', 'a2_review',
  format($q$ select public.inventory_review_adjustment(%L, 'APPROVE', null, gen_random_uuid()) $q$, rls_test.get('a2') ->> 'adjustment_id'));
select rls_test.ok('source correction: quantity moved from UNKNOWN to IN_HOUSE, total unchanged',
  rls_test.on_hand(rls_test.id('p_kg'), null, 'UNKNOWN') = 0 and rls_test.on_hand(rls_test.id('p_kg'), null, 'IN_HOUSE') = 12.5
  and rls_test.on_hand(rls_test.id('p_kg')) = 12.5);

-- Segregation of duties can be turned off by company policy.
reset role;
update public.company_settings set setting_value = 'false' where company_id = rls_test.id('company_a') and setting_key = 'inventory.segregation_of_duties';
set local role authenticated;
select rls_test.claims('im');
select rls_test.expect_call_ok('policy: with SoD disabled a manager can request a batch adjustment', 'a3',
  format($q$ select public.inventory_create_adjustment('QUANTITY', %L, %L, 'LOSS', p_batch_id => (select batch_id from public.inventory_balances where product_id = %L limit 1),
             p_counted_quantity => 28, p_reference => 'LOSS-1', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('p_bat'), rls_test.id('g1'), rls_test.id('p_bat')));
select rls_test.expect_call_ok('policy: ...and approve it', 'a3_review',
  format($q$ select public.inventory_review_adjustment(%L, 'APPROVE', null, gen_random_uuid()) $q$, rls_test.get('a3') ->> 'adjustment_id'));
reset role;
update public.company_settings set setting_value = 'true' where company_id = rls_test.id('company_a') and setting_key = 'inventory.segregation_of_duties';
set local role authenticated;
select rls_test.ok('batch attribution: batch B-001 is still OUTSOURCED with 28 units',
  (select bool_and(bt.batch_number = 'B-001' and bt.source_type = 'OUTSOURCED') and sum(b.on_hand) = 28
   from public.inventory_balances b join public.inventory_batches bt on bt.id = b.batch_id where b.product_id = rls_test.id('p_bat')));

-- ===========================================================================
-- PHYSICAL STOCK COUNT
-- ===========================================================================
select rls_test.claims('im');
select rls_test.expect_call_ok('count: started for warehouse W1 with system snapshot', 'c1',
  format($q$ select public.inventory_create_count(%L, p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('w1')));
select rls_test.ok('count: snapshot lines match current balances (4 lots with stock)',
  (rls_test.get('c1') ->> 'line_count')::int = 4, rls_test.get('c1')::text);
select rls_test.expect_call_ok('count: record counted quantities (one variance, one uncounted line)', 'c1_record',
  format($q$ select public.inventory_record_count(%L, (select jsonb_agg(jsonb_build_object('line_id', l.id,
               'counted_quantity', case when p.sku = 'INV-PCS' and l.source_type = 'IN_HOUSE' then 52 when p.sku = 'INV-BAT' then null else l.system_quantity end))
             from public.inventory_count_lines l join public.products p on p.id = l.product_id where l.count_id = %L)) $q$,
  rls_test.get('c1') ->> 'count_id', rls_test.get('c1') ->> 'count_id'));
select rls_test.ok('count: recording quantities does not change stock',
  rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 55);
select rls_test.expect_call_ok('count: submitted', 'c1_submit', format($q$ select public.inventory_submit_count(%L) $q$, rls_test.get('c1') ->> 'count_id'));
select rls_test.expect_call_error('count: counter cannot approve own count',
  format($q$ select public.inventory_review_count(%L, 'APPROVE', null, gen_random_uuid()) $q$, rls_test.get('c1') ->> 'count_id'), 'Segregation');
select rls_test.claims('im2');
select rls_test.expect_call_ok('count: approved by another manager', 'c1_review',
  format($q$ select public.inventory_review_count(%L, 'APPROVE', null, gen_random_uuid()) $q$, rls_test.get('c1') ->> 'count_id'));
select rls_test.ok('count: approval posted exactly the variance (-3) as one adjustment; uncounted line ignored',
  rls_test.on_hand(rls_test.id('p_pcs'), rls_test.id('g1'), 'IN_HOUSE') = 52 and rls_test.on_hand(rls_test.id('p_bat')) = 28
  and (select count(*) = 1 from public.inventory_transactions where document_type = 'COUNT' and document_id = (rls_test.get('c1') ->> 'count_id')::uuid));

-- ===========================================================================
-- HISTORICAL STOCK, OVERVIEW, RECONCILIATION
-- ===========================================================================
select rls_test.expect_rows('history: nothing before opening stock (no fabricated balances)',
  format($q$ select * from public.inventory_stock_as_of(%L) $q$, rls_test.today() - 11), 0);
select rls_test.ok('history: as of the opening date shows only opening quantities',
  (select sum(quantity) = 140 from public.inventory_stock_as_of(rls_test.today() - 10) where sku = 'INV-PCS'));
select rls_test.ok('history: as of today equals the current balances',
  (select sum(quantity) from public.inventory_stock_as_of(rls_test.today()) where sku = 'INV-PCS') = rls_test.on_hand(rls_test.id('p_pcs')));
select rls_test.set('overview', public.inventory_overview());
select rls_test.ok('overview: KPIs match database balances, grouped by unit',
  (select (u ->> 'on_hand')::numeric = rls_test.on_hand(rls_test.id('p_pcs')) and (u ->> 'in_house')::numeric = 52 and (u ->> 'outsourced')::numeric = 40
   from jsonb_array_elements(rls_test.get('overview') -> 'units') u where u ->> 'unit' = 'PCS')
  and (select count(*) = 3 from jsonb_array_elements(rls_test.get('overview') -> 'units')),
  (rls_test.get('overview') -> 'units')::text);
select rls_test.ok('overview: active product count is real', (rls_test.get('overview') ->> 'active_products')::int = 3);
select rls_test.set('reconcile', rls_test.call('select public.inventory_reconcile()'));
select rls_test.ok('reconciliation: derived balances equal the ledger after all operations',
  jsonb_array_length(rls_test.get('reconcile') -> 'mismatches') = 0 and (rls_test.get('reconcile') ->> 'checked')::int > 0,
  rls_test.get('reconcile')::text);

-- ===========================================================================
-- ALERTS
-- ===========================================================================
reset role;
update public.products set reorder_level = 20 where id = rls_test.id('p_kg');
set local role authenticated;
select rls_test.claims('viewer');
select rls_test.expect_call_ok('alerts: refresh from real balances', 'al1', 'select public.inventory_refresh_alerts()');
select rls_test.ok('alerts: low stock (12.5 <= 20) and expiring batch detected',
  (select count(*) = 1 from public.inventory_alerts where alert_type = 'LOW_STOCK' and product_id = rls_test.id('p_kg') and status = 'OPEN')
  and (select count(*) = 1 from public.inventory_alerts where alert_type = 'EXPIRING' and product_id = rls_test.id('p_bat') and status = 'OPEN'));
select rls_test.expect_call_ok('alerts: second refresh', 'al2', 'select public.inventory_refresh_alerts()');
select rls_test.ok('alerts: refreshing does not create duplicates',
  (rls_test.get('al2') ->> 'opened')::int = 0 and (rls_test.get('al2') ->> 'active') = (rls_test.get('al1') ->> 'active'));
select rls_test.expect_call_error('alerts: Management Viewer cannot acknowledge',
  format($q$ select public.inventory_acknowledge_alert(id, 'seen') from public.inventory_alerts where alert_type = 'LOW_STOCK' and product_id = %L $q$, rls_test.id('p_kg')), 'not allowed');
select rls_test.claims('im');
select rls_test.expect_call_ok('alerts: Inventory Manager acknowledges', 'ack',
  format($q$ select public.inventory_acknowledge_alert(id, 'Reorder raised') from public.inventory_alerts where alert_type = 'LOW_STOCK' and product_id = %L $q$, rls_test.id('p_kg')));
select rls_test.expect_call_ok('alerts: refresh after acknowledgement', 'al3', 'select public.inventory_refresh_alerts()');
select rls_test.ok('alerts: acknowledged alert kept (with who/when), not re-opened',
  (select count(*) = 1 and bool_and(status = 'ACKNOWLEDGED' and acknowledged_by = rls_test.id('im')) from public.inventory_alerts
   where alert_type = 'LOW_STOCK' and product_id = rls_test.id('p_kg')));

-- Reservation expiry restores availability.
select rls_test.expect_call_ok('reservation: create with an expiry time', 'res4',
  format($q$ select public.inventory_create_reservation(%L, %L, 5, 'QUOTE', 'Q-1', p_source_type => 'OUTSOURCED', p_expires_at => now() + interval '1 hour', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('p_pcs'), rls_test.id('g1')));
reset role;
update public.stock_reservations set expires_at = now() - interval '1 minute' where id = (rls_test.get('res4') ->> 'reservation_id')::uuid;
set local role authenticated;
select rls_test.claims('viewer');
select rls_test.expect_call_ok('reservation: expiry job', 'exp', 'select to_jsonb(public.inventory_expire_reservations())');
select rls_test.ok('reservation: expired reservation released its quantity',
  rls_test.reserved(rls_test.id('p_pcs'), rls_test.id('g1'), 'OUTSOURCED') = 0
  and (select reservation_status = 'EXPIRED' from public.stock_reservations where id = (rls_test.get('res4') ->> 'reservation_id')::uuid));

-- ===========================================================================
-- WAREHOUSES, LOCATIONS, PRODUCT GUARDS
-- ===========================================================================
select rls_test.claims('im');
select rls_test.expect_call_ok('transfer: move 5 outsourced units into BIN-1', 't2',
  format($q$ select public.inventory_transfer_stock(%L, %L, %L, 5, p_source_type => 'OUTSOURCED', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('p_pcs'), rls_test.id('g1'), rls_test.id('bin1')));
select rls_test.expect_error('locations: cannot deactivate a location holding stock',
  format($q$ update public.inventory_locations set status = 'INACTIVE' where id = %L $q$, rls_test.id('bin1')));
select rls_test.expect_error('warehouses: cannot deactivate a warehouse holding stock',
  format($q$ update public.warehouses set status = 'INACTIVE' where id = %L $q$, rls_test.id('w1')));
select rls_test.expect_error('locations: the default location cannot be deactivated',
  format($q$ update public.inventory_locations set status = 'INACTIVE' where id = %L $q$, rls_test.id('g2')));
select rls_test.expect_error('warehouses: duplicate code in the same company is rejected',
  format($q$ insert into public.warehouses (company_id, warehouse_code, warehouse_name) values (%L, 'w1', 'Dup') $q$, rls_test.id('company_a')));
select rls_test.expect_error('warehouses/locations: cannot be deleted',
  format($q$ delete from public.inventory_locations where id = %L $q$, rls_test.id('old')));
select rls_test.expect_affected('locations: a location can be created',
  format($q$ insert into public.inventory_locations (company_id, warehouse_id, location_code, location_name) values (%L, %L, 'EMPTY-1', 'Empty bin') $q$,
  rls_test.id('company_a'), rls_test.id('w2')), 1);
select rls_test.expect_affected('locations: an empty location can be deactivated',
  $q$ update public.inventory_locations set status = 'INACTIVE' where location_code = 'EMPTY-1' $q$, 1);
select rls_test.expect_error('products: unit cannot change after stock exists',
  format($q$ update public.products set base_unit = 'SET' where id = %L $q$, rls_test.id('p_pcs')));
select rls_test.expect_error('products: SKU cannot change after stock exists',
  format($q$ update public.products set sku = 'INV-PCS-2' where id = %L $q$, rls_test.id('p_pcs')));
select rls_test.expect_affected('products: deactivating a product that has stock is allowed (stock is kept)',
  format($q$ update public.products set status = 'INACTIVE' where id = %L $q$, rls_test.id('p_kg')), 1);
select rls_test.expect_error('products: a product with stock cannot be archived',
  format($q$ update public.products set archived_at = now() where id = %L $q$, rls_test.id('p_kg')));
select rls_test.expect_call_error('receipt: inactive product cannot receive new stock',
  format($q$ select public.inventory_post_receipt(%L, %L, 1, 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('p_kg'), rls_test.id('g1')), 'inactive');

-- ===========================================================================
-- DIRECT WRITES AND LEDGER IMMUTABILITY
-- ===========================================================================
select rls_test.expect_error('ledger: clients cannot insert ledger rows directly',
  format($q$ insert into public.inventory_transactions (company_id, transaction_number, transaction_type, direction, product_id, batch_id, warehouse_id, location_id, quantity, unit, source_type, reason, transaction_date)
             select company_id, 'FAKE-1', 'RECEIPT', 1, product_id, batch_id, warehouse_id, location_id, 999, 'PCS', source_type, 'fake', now() from public.inventory_balances limit 1 $q$));
select rls_test.expect_error('balances: clients cannot edit balance quantities',
  $q$ update public.inventory_balances set on_hand = on_hand + 1000 $q$);
select rls_test.expect_error('reservations: clients cannot edit reservations directly',
  $q$ update public.stock_reservations set reservation_status = 'RELEASED' $q$);
select rls_test.expect_error('adjustments: clients cannot mark adjustments posted directly',
  $q$ update public.inventory_adjustments set status = 'POSTED' $q$);
reset role;
select rls_test.expect_error('ledger: posted transactions cannot be updated, even by the owner',
  $q$ update public.inventory_transactions set quantity = quantity + 1 $q$);
select rls_test.expect_error('ledger: posted transactions cannot be deleted, even by the owner',
  $q$ delete from public.inventory_transactions $q$);
set local role authenticated;

-- ===========================================================================
-- CROSS-COMPANY ISOLATION (Inventory Manager of company B)
-- ===========================================================================
select rls_test.claims('b_im');
select rls_test.expect_rows('cross-company: cannot read company A balances',
  format('select * from public.inventory_balances where company_id = %L', rls_test.id('company_a')), 0);
select rls_test.expect_rows('cross-company: cannot read company A ledger',
  format('select * from public.inventory_transactions where company_id = %L', rls_test.id('company_a')), 0);
select rls_test.expect_rows('cross-company: cannot read company A warehouses', format('select * from public.warehouses where company_id = %L', rls_test.id('company_a')), 0);
select rls_test.expect_rows('cross-company: stock views show nothing of company A',
  format('select * from public.inventory_stock_detail where company_id = %L', rls_test.id('company_a')), 0);
select rls_test.expect_call_error('cross-company: cannot receive into company A product/location',
  format($q$ select public.inventory_post_receipt(%L, %L, 1, 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('p_pcs'), rls_test.id('g1')), 'not found');
select rls_test.expect_call_error('cross-company: cannot receive own product into a company A location',
  format($q$ select public.inventory_post_receipt(%L, %L, 1, 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('p_b'), rls_test.id('g1')), 'not found');
select rls_test.expect_call_error('cross-company: cannot transfer company A stock',
  format($q$ select public.inventory_transfer_stock(%L, %L, %L, 1, p_source_type => 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('p_pcs'), rls_test.id('g1'), rls_test.id('gb')), 'not found');
select rls_test.expect_call_error('cross-company: cannot reserve company A stock',
  format($q$ select public.inventory_create_reservation(%L, %L, 1, 'X', 'X', p_source_type => 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.id('p_pcs'), rls_test.id('g1')), 'not found');
select rls_test.expect_call_error('cross-company: cannot reverse a company A transaction',
  format($q$ select public.inventory_reverse_transaction(%L, 'Attack', gen_random_uuid()) $q$, rls_test.get('i1') ->> 'transaction_id'), 'not found');
select rls_test.expect_call_error('cross-company: cannot approve a company A adjustment',
  format($q$ select public.inventory_review_adjustment(%L, 'APPROVE', null, gen_random_uuid()) $q$, rls_test.get('a1') ->> 'adjustment_id'), 'not found');
select rls_test.set('b_open', rls_test.call(format($q$ select public.inventory_submit_opening_stock_at_cost(%L::jsonb, 'MANUAL', null, null, gen_random_uuid()) $q$,
  jsonb_build_array(jsonb_build_object('line_no', 1, 'product_id', rls_test.id('p_pcs'), 'location_id', rls_test.id('gb'), 'source_type', 'IN_HOUSE', 'quantity', 1, 'effective_date', rls_test.today())))));
select rls_test.ok('cross-company: opening stock for a company A product is rejected',
  (rls_test.get('b_open') ->> 'ok') = 'false' and rls_test.get('b_open')::text ilike '%Product not found%', rls_test.get('b_open')::text);
select rls_test.expect_call_ok('cross-company: company B posts its own receipt (same SKU text as A)', 'b_r1',
  format($q$ select public.inventory_post_receipt(%L, %L, 7, 'IN_HOUSE', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('p_b'), rls_test.id('gb')));
select rls_test.ok('cross-company: company B overview counts only company B stock',
  (select (u ->> 'on_hand')::numeric = 7 from jsonb_array_elements(public.inventory_overview() -> 'units') u where u ->> 'unit' = 'PCS'));
select rls_test.ok('cross-company: transaction numbers are per company',
  (select transaction_number = 'TXN-000001' from public.inventory_transactions where id = (rls_test.get('b_r1') ->> 'transaction_id')::uuid));

reset role;

-- ---------------------------------------------------------------------------
-- Summary (always raises so all test data is rolled back)
-- ---------------------------------------------------------------------------
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
  raise exception 'INVENTORY_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
