-- =============================================================================
-- MANUFACTURING & OUTSOURCING (PHASE 5) VERIFICATION
--
-- Executable checks for BOMs, planning, production orders, reservations,
-- material issue, output receipts, outsourcing, traceability, costing, RLS,
-- authorisation, reversals and idempotency.
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction with its own test companies (PRDA / PRDB) and users
-- (@prd.example.invalid), and ALWAYS ends by raising
--   PRODUCTION_VERIFICATION_RESULT passed=N failed=M
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

-- Owner-side probes (bypass RLS) used to assert actual stored state.
create function rls_test.on_hand(p_product uuid, p_location uuid default null) returns numeric
language sql stable security definer as $$
  select coalesce(sum(on_hand), 0) from public.inventory_balances where product_id = p_product and (p_location is null or location_id = p_location) $$;
create function rls_test.reserved(p_product uuid, p_location uuid default null) returns numeric
language sql stable security definer as $$
  select coalesce(sum(reserved), 0) from public.inventory_balances where product_id = p_product and (p_location is null or location_id = p_location) $$;
create function rls_test.ledger_count(p_product uuid, p_type text default null) returns bigint
language sql stable security definer as $$
  select count(*) from public.inventory_transactions where product_id = p_product and (p_type is null or transaction_type = p_type) $$;
create function rls_test.lot(p_product uuid, p_batch text default null) returns uuid
language sql stable security definer as $$
  select id from public.inventory_batches where product_id = p_product
    and ((p_batch is null and is_system_lot) or lower(batch_number) = lower(p_batch)) order by created_at limit 1 $$;
create function rls_test.order_row(p_id uuid) returns public.production_orders
language sql stable security definer as $$ select * from public.production_orders where id = p_id $$;
create function rls_test.material(p_order uuid, p_product uuid) returns public.production_order_materials
language sql stable security definer as $$ select * from public.production_order_materials where production_order_id = p_order and component_product_id = p_product $$;
create function rls_test.omaterial(p_order uuid, p_product uuid) returns public.outsourcing_order_materials
language sql stable security definer as $$ select * from public.outsourcing_order_materials where outsourcing_order_id = p_order and component_product_id = p_product $$;
create function rls_test.oorder(p_id uuid) returns public.outsourcing_orders
language sql stable security definer as $$ select * from public.outsourcing_orders where id = p_id $$;
create function rls_test.open_res(p_order uuid) returns numeric
language sql stable security definer as $$
  select coalesce(sum(quantity - fulfilled_quantity - released_quantity), 0) from public.stock_reservations
  where reference_id = p_order and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') $$;
create function rls_test.today() returns date language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;

grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures (database owner)
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e57200-0000-4000-8000-0000000000a1'), ('company_b', 'e7e57200-0000-4000-8000-0000000000b1'),
  ('pm',     'e7e57200-0000-4000-8000-000000000002'),  -- Production Manager A (requester)
  ('pm2',    'e7e57200-0000-4000-8000-000000000003'),  -- Production Manager A (approver)
  ('im',     'e7e57200-0000-4000-8000-000000000004'),  -- Inventory Manager A (stores)
  ('adm',    'e7e57200-0000-4000-8000-000000000005'),  -- Admin A
  ('pur',    'e7e57200-0000-4000-8000-000000000006'),  -- Purchase Manager A
  ('viewer', 'e7e57200-0000-4000-8000-000000000007'),  -- Management Viewer A
  ('sales',  'e7e57200-0000-4000-8000-000000000008'),  -- Sales Manager A (no production rights)
  ('b_pm',   'e7e57200-0000-4000-8000-000000000009'),  -- Production Manager B
  ('fg',     'e7e57200-0000-4000-8000-0000000000c1'), ('fg2',   'e7e57200-0000-4000-8000-0000000000c2'),
  ('clay',   'e7e57200-0000-4000-8000-0000000000c3'), ('glaze', 'e7e57200-0000-4000-8000-0000000000c4'),
  ('box',    'e7e57200-0000-4000-8000-0000000000c5'), ('sub',   'e7e57200-0000-4000-8000-0000000000c6'),
  ('semi',   'e7e57200-0000-4000-8000-0000000000c7'), ('misc',  'e7e57200-0000-4000-8000-0000000000c8'),
  ('tape',   'e7e57200-0000-4000-8000-0000000000c9'), ('fg3',   'e7e57200-0000-4000-8000-0000000000ca'),
  ('b_fg',   'e7e57200-0000-4000-8000-0000000000d1'), ('b_rm',  'e7e57200-0000-4000-8000-0000000000d2'),
  ('w1',     'e7e57200-0000-4000-8000-0000000000e1'), ('w2',    'e7e57200-0000-4000-8000-0000000000e2'),
  ('wb',     'e7e57200-0000-4000-8000-0000000000e3'),
  ('rej',    'e7e57200-0000-4000-8000-0000000000f1'), ('ext',   'e7e57200-0000-4000-8000-0000000000f2');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code) values
  (rls_test.id('company_a'), 'Production Test A', 'Production Test A', 'PRDA'),
  (rls_test.id('company_b'), 'Production Test B', 'Production Test B', 'PRDB');
-- V2 turns segregation of duties off by default (single operator). This suite tests it, so it switches it on.
insert into public.company_settings (company_id, setting_key, setting_value)
select id, 'inventory.segregation_of_duties', 'true'::jsonb from public.companies where id in (rls_test.id('company_a'), rls_test.id('company_b'));

insert into auth.users (id, email)
select id, key || '@prd.example.invalid' from rls_test.ids where key in ('pm', 'pm2', 'im', 'adm', 'pur', 'viewer', 'sales', 'b_pm');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true
  where id in (rls_test.id('pm'), rls_test.id('pm2'), rls_test.id('im'), rls_test.id('adm'), rls_test.id('pur'), rls_test.id('viewer'), rls_test.id('sales'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_pm');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('pm'),     rls_test.id('company_a'), rls_test.id('role_production_manager')),
  (rls_test.id('pm2'),    rls_test.id('company_a'), rls_test.id('role_production_manager')),
  (rls_test.id('im'),     rls_test.id('company_a'), rls_test.id('role_inventory_manager')),
  (rls_test.id('adm'),    rls_test.id('company_a'), rls_test.id('role_admin')),
  (rls_test.id('pur'),    rls_test.id('company_a'), rls_test.id('role_purchase_manager')),
  (rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_management_viewer')),
  (rls_test.id('sales'),  rls_test.id('company_a'), rls_test.id('role_sales_manager')),
  (rls_test.id('b_pm'),   rls_test.id('company_b'), rls_test.id('role_production_manager'));
-- The inventory manager also needs to reconcile and the production manager to receive test stock.
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('pm'), rls_test.id('company_a'), rls_test.id('role_inventory_manager'));

insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, track_batches, track_expiry, standard_cost) values
  (rls_test.id('fg'),    rls_test.id('company_a'), 'PRD-FG',    'Test closet',         'FINISHED_GOOD',      'IN_HOUSE',   'PCS', true,  false, null),
  (rls_test.id('fg2'),   rls_test.id('company_a'), 'PRD-FG2',   'Bought-in basin',     'FINISHED_GOOD',      'OUTSOURCED', 'PCS', false, false, null),
  (rls_test.id('fg3'),   rls_test.id('company_a'), 'PRD-FG3',   'Unit test closet',    'FINISHED_GOOD',      'IN_HOUSE',   'PCS', false, false, null),
  (rls_test.id('clay'),  rls_test.id('company_a'), 'PRD-CLAY',  'Ceramic body',        'RAW_MATERIAL',       'OUTSOURCED', 'KG',  false, false, 10),
  (rls_test.id('glaze'), rls_test.id('company_a'), 'PRD-GLZ',   'Glaze',               'RAW_MATERIAL',       'OUTSOURCED', 'KG',  true,  false, 50),
  (rls_test.id('box'),   rls_test.id('company_a'), 'PRD-BOX',   'Carton',              'PACKAGING_MATERIAL', 'OUTSOURCED', 'PCS', false, false, 2),
  (rls_test.id('sub'),   rls_test.id('company_a'), 'PRD-SUB',   'Sub-assembly',        'COMPONENT',          'IN_HOUSE',   'PCS', false, false, null),
  (rls_test.id('semi'),  rls_test.id('company_a'), 'PRD-SEMI',  'Processed blank',     'COMPONENT',          'HYBRID',     'PCS', false, false, null),
  (rls_test.id('misc'),  rls_test.id('company_a'), 'PRD-MISC',  'Misc item',           'OTHER',              'OUTSOURCED', 'PCS', false, false, null),
  (rls_test.id('tape'),  rls_test.id('company_a'), 'PRD-TAPE',  'Sealing tape',        'PACKAGING_MATERIAL', 'OUTSOURCED', 'M',   false, false, null),
  (rls_test.id('b_fg'),  rls_test.id('company_b'), 'PRD-FG',    'Company B closet',    'FINISHED_GOOD',      'IN_HOUSE',   'PCS', false, false, null),
  (rls_test.id('b_rm'),  rls_test.id('company_b'), 'PRD-CLAY',  'Company B clay',      'RAW_MATERIAL',       'OUTSOURCED', 'KG',  false, false, null);

insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Plant store', true),
  (rls_test.id('w2'), rls_test.id('company_a'), 'W2', 'Second store', false),
  (rls_test.id('wb'), rls_test.id('company_b'), 'W1', 'Company B store', true);
insert into public.inventory_locations (id, company_id, warehouse_id, location_code, location_name, location_type, stock_usage, external_holder) values
  (rls_test.id('rej'), rls_test.id('company_a'), rls_test.id('w1'), 'REJECT', 'Rejected goods bay', 'AREA', 'REJECTED', null),
  (rls_test.id('ext'), rls_test.id('company_a'), rls_test.id('w1'), 'JOB-TP', 'At Test Processor', 'AREA', 'EXTERNAL_PROCESSING', 'Test Processor (job worker)');
insert into rls_test.ids (key, id)
select case warehouse_id when rls_test.id('w1') then 'g1' when rls_test.id('w2') then 'g2' else 'gb' end, id
from public.inventory_locations where location_code = 'GENERAL' and warehouse_id in (rls_test.id('w1'), rls_test.id('w2'), rls_test.id('wb'));

select rls_test.ok('RLS enabled on every public table (including Phase 5 tables)',
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity));
select rls_test.ok('clients have no write privileges on BOM, production or outsourcing tables',
  not exists (select 1 from unnest(array['boms', 'bom_items', 'production_orders', 'production_order_materials',
      'production_material_consumption', 'production_output_receipts', 'production_order_events', 'outsourcing_orders',
      'outsourcing_order_materials', 'outsourcing_receipts', 'outsourcing_material_movements', 'outsourcing_order_events']) t
    where has_table_privilege('authenticated', 'public.' || t, 'INSERT,UPDATE,DELETE')));
select rls_test.ok('no separate stock tables were created for production (one ledger)',
  not exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name in ('production_orders', 'boms', 'outsourcing_orders', 'production_output_receipts')
              and column_name in ('on_hand', 'available', 'stock_balance')));
select rls_test.ok('a location cannot be both default and non-storage',
  (rls_test.call(format($q$ update public.inventory_locations set stock_usage = 'REJECTED' where id = %L returning jsonb_build_object('x', 1) $q$,
    rls_test.id('g1'))) ? 'error'));

-- Opening stock for materials (Phase 4 receipt RPC; purchased materials).
set local role authenticated;
select rls_test.claims('im');
select rls_test.expect_call_ok('setup: receive 100 KG clay (costed)', 'r_clay',
  format($q$ select public.inventory_post_receipt(%L, %L, 100, 'OUTSOURCED', p_unit_cost => 10, p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('clay'), rls_test.id('g1')));
select rls_test.expect_call_ok('setup: receive 20 KG glaze batch G-1 (cost unknown)', 'r_glaze',
  format($q$ select public.inventory_post_receipt(%L, %L, 20, 'OUTSOURCED', p_batch_number => 'G-1', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('glaze'), rls_test.id('g1')));
select rls_test.expect_call_ok('setup: receive 50 cartons (costed)', 'r_box',
  format($q$ select public.inventory_post_receipt(%L, %L, 50, 'OUTSOURCED', p_unit_cost => 2, p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('box'), rls_test.id('g1')));
reset role;
insert into rls_test.ids (key, id) values
  ('lot_clay', rls_test.lot(rls_test.id('clay'))), ('lot_glaze', rls_test.lot(rls_test.id('glaze'), 'G-1')), ('lot_box', rls_test.lot(rls_test.id('box')));

-- ===========================================================================
-- 1-2. BOM CREATION, VALIDATION AND APPROVAL
-- ===========================================================================
set local role authenticated;
select rls_test.set('bom_items', jsonb_build_array(
  jsonb_build_object('component_product_id', rls_test.id('clay'),  'quantity_required', 2.5),
  jsonb_build_object('component_product_id', rls_test.id('glaze'), 'quantity_required', 0.2, 'wastage_percentage', 10),
  jsonb_build_object('component_product_id', rls_test.id('box'),   'quantity_required', 1, 'unit', 'pcs')));

select rls_test.claims('viewer');
select rls_test.expect_call_error('bom: Management Viewer cannot create a BOM',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('fg'), rls_test.today(), rls_test.get('bom_items')), 'not allowed');
select rls_test.claims('sales');
select rls_test.expect_call_error('bom: Sales Manager cannot create a BOM',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('fg'), rls_test.today(), rls_test.get('bom_items')), 'not allowed');

select rls_test.claims('pm');
-- V2: any product type may be a component. Line 1 (an OTHER-type product) passes
-- the checks; the save still fails on the duplicate line 2, so nothing is created.
select rls_test.expect_call_error('bom (V2): an OTHER-type product is accepted as a component (fails only on the duplicate line 2)',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('fg'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('misc'), 'quantity_required', 1),
                      jsonb_build_object('component_product_id', rls_test.id('misc'), 'quantity_required', 1))), 'Line 2');
select rls_test.expect_call_error('bom: a raw material cannot be a BOM output',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('clay'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('box'), 'quantity_required', 1))), 'cannot have a BOM');
select rls_test.expect_call_error('bom: duplicate component rows are rejected',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('fg'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('box'), 'quantity_required', 1),
                      jsonb_build_object('component_product_id', rls_test.id('box'), 'quantity_required', 2))), 'more than once');
select rls_test.expect_call_error('bom: zero quantity is rejected',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('fg'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('box'), 'quantity_required', 0))), 'greater than zero');
select rls_test.expect_call_error('bom: negative wastage is rejected',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('fg'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('box'), 'quantity_required', 1, 'wastage_percentage', -1))), 'wastage');
select rls_test.expect_call_error('bom: a unit different from the inventory unit is rejected (no conversion)',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('fg'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('clay'), 'quantity_required', 1, 'unit', 'PCS'))), 'does not match the inventory unit');
select rls_test.expect_call_error('bom: a product cannot be its own component',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('sub'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('sub'), 'quantity_required', 1))), 'component of itself');
select rls_test.expect_call_error('bom: another company''s product cannot be a component',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('fg'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('b_rm'), 'quantity_required', 1))), 'not found');
select rls_test.expect_call_error('bom: effective-to before effective-from is rejected',
  format($q$ select public.production_save_bom(null, %L, %L, %L, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('fg'), rls_test.today(), rls_test.today() - 1,
    rls_test.get('bom_items')), 'effective-to');

select rls_test.set('ledger_before_bom', to_jsonb(rls_test.ledger_count(rls_test.id('clay'))));
select rls_test.expect_call_ok('bom: Production Manager creates a valid BOM (3 components, wastage)', 'bom1',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, 'Test BOM', %L::jsonb, 'e7e5f200-0000-4000-8000-000000000001') $q$,
    rls_test.id('fg'), rls_test.today() - 30, rls_test.get('bom_items')));
select rls_test.ok('bom: creating a BOM moves no stock', rls_test.ledger_count(rls_test.id('clay')) = (rls_test.get('ledger_before_bom'))::bigint
  and rls_test.on_hand(rls_test.id('clay')) = 100);
select rls_test.set('bom1_dup', rls_test.call(format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, 'e7e5f200-0000-4000-8000-000000000001') $q$,
  rls_test.id('fg'), rls_test.today(), rls_test.get('bom_items'))));
select rls_test.ok('bom: retried create (same request id) returns the same BOM, no duplicate',
  rls_test.gid('bom1_dup', 'bom_id') = rls_test.gid('bom1', 'bom_id') and (rls_test.get('bom1_dup') ->> 'duplicate') = 'true'
  and (select count(*) = 1 from public.boms where finished_product_id = rls_test.id('fg')), rls_test.get('bom1_dup')::text);
select rls_test.ok('bom: version 1, code BOM-000001, unit normalised to the inventory unit',
  (select version = 1 and bom_code = 'BOM-000001' and status = 'DRAFT' from public.boms where id = rls_test.gid('bom1', 'bom_id'))
  and (select bool_and(bi.unit = p.base_unit) and count(*) = 3 from public.bom_items bi join public.products p on p.id = bi.component_product_id
       where bi.bom_id = rls_test.gid('bom1', 'bom_id')));

-- Circular BOMs (sub-assemblies)
select rls_test.expect_call_ok('bom: sub-assembly BOM (SUB needs SEMI)', 'bom_sub',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('sub'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('semi'), 'quantity_required', 1))));
select rls_test.expect_call_error('bom: circular reference (SEMI needs SUB which needs SEMI) is rejected',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('semi'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('sub'), 'quantity_required', 1))), 'Circular');

-- Approval with segregation of duties
select rls_test.expect_call_ok('bom: creator submits the BOM', 'bom1_submit',
  format($q$ select public.production_bom_action(%L, 'SUBMIT') $q$, rls_test.gid('bom1', 'bom_id')));
select rls_test.expect_call_error('bom: creator cannot approve own BOM (segregation of duties)',
  format($q$ select public.production_bom_action(%L, 'APPROVE') $q$, rls_test.gid('bom1', 'bom_id')), 'Segregation of duties');
select rls_test.claims('im');
select rls_test.expect_call_error('bom: Inventory Manager cannot approve a BOM',
  format($q$ select public.production_bom_action(%L, 'APPROVE') $q$, rls_test.gid('bom1', 'bom_id')), 'not allowed');
select rls_test.claims('viewer');
select rls_test.expect_call_error('bom: Management Viewer cannot approve a BOM',
  format($q$ select public.production_bom_action(%L, 'APPROVE') $q$, rls_test.gid('bom1', 'bom_id')), 'not allowed');
select rls_test.claims('pm2');
select rls_test.expect_call_error('bom: rejection requires a reason',
  format($q$ select public.production_bom_action(%L, 'REJECT') $q$, rls_test.gid('bom1', 'bom_id')), 'reason');
select rls_test.expect_call_ok('bom: second Production Manager approves', 'bom1_approve',
  format($q$ select public.production_bom_action(%L, 'APPROVE', 'Checked') $q$, rls_test.gid('bom1', 'bom_id')));
select rls_test.expect_call_error('bom: an approved BOM cannot be edited',
  format($q$ select public.production_save_bom(%L, %L, %L, null, 2, null, %L::jsonb) $q$, rls_test.gid('bom1', 'bom_id'), rls_test.id('fg'), rls_test.today(), rls_test.get('bom_items')), 'Only draft');
select rls_test.expect_error('bom: clients cannot update BOM rows directly',
  format($q$ update public.boms set output_quantity = 5 where id = %L $q$, rls_test.gid('bom1', 'bom_id')));
reset role;
select rls_test.expect_error('bom: approved BOM components are immutable even for the database owner',
  format($q$ update public.bom_items set quantity_required = 9 where bom_id = %L $q$, rls_test.gid('bom1', 'bom_id')));
set local role authenticated;

-- ===========================================================================
-- 3-5. PLANNING (sufficient, shortage, unit mismatch) — never moves stock
-- ===========================================================================
select rls_test.claims('pm');
select rls_test.expect_rows('planning: requirements for 10 units are all sufficient',
  format($q$ select * from public.production_bom_requirements(%L, 10, %L) where line_status = 'SUFFICIENT' $q$, rls_test.gid('bom1', 'bom_id'), rls_test.id('w1')), 3);
select rls_test.ok('planning: required = qty per unit x quantity, plus wastage (glaze 0.2 x 10 + 10% = 2.2)',
  (select base_requirement = 2 and wastage_allowance = 0.2 and total_requirement = 2.2 and available = 20 and shortage = 0
   from public.production_bom_requirements(rls_test.gid('bom1', 'bom_id'), 10, rls_test.id('w1')) where component_product_id = rls_test.id('glaze')));
select rls_test.ok('planning: shortage = max(required - available, 0) for 60 units (clay 150 vs 100)',
  (select line_status = 'PARTIAL' and total_requirement = 150 and shortage = 50 and suggested_quantity = 50
   from public.production_bom_requirements(rls_test.gid('bom1', 'bom_id'), 60, rls_test.id('w1')) where component_product_id = rls_test.id('clay')));
select rls_test.expect_rows('planning: no stock in the second warehouse means complete shortage',
  format($q$ select * from public.production_bom_requirements(%L, 10, %L) where line_status = 'SHORTAGE' and shortage = total_requirement $q$,
    rls_test.gid('bom1', 'bom_id'), rls_test.id('w2')), 3);
select rls_test.ok('planning: planning moved no stock and reserved nothing',
  rls_test.on_hand(rls_test.id('clay')) = 100 and rls_test.reserved(rls_test.id('clay')) = 0);

-- Unit mismatch: a BOM for FG3 with tape, approved, then tape's unit changes (no stock, allowed).
select rls_test.expect_call_ok('unit: BOM for FG3 with sealing tape', 'bom_fg3',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('fg3'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('tape'), 'quantity_required', 1.5))));
select rls_test.call(format($q$ select public.production_bom_action(%L, 'SUBMIT') $q$, rls_test.gid('bom_fg3', 'bom_id')));
select rls_test.claims('pm2');
select rls_test.call(format($q$ select public.production_bom_action(%L, 'APPROVE') $q$, rls_test.gid('bom_fg3', 'bom_id')));
reset role;
update public.products set base_unit = 'ROLL' where id = rls_test.id('tape');
set local role authenticated;
select rls_test.claims('pm');
select rls_test.ok('unit: planning flags a BOM/inventory unit mismatch and does not calculate a shortage',
  (select line_status = 'UNIT_MISMATCH' and shortage is null and available is null
   from public.production_bom_requirements(rls_test.gid('bom_fg3', 'bom_id'), 5, rls_test.id('w1'))));
select rls_test.expect_call_error('unit: an order cannot be created from a BOM with a unit mismatch',
  format($q$ select public.production_save_order(null, %L, 5, %L, %L, %L, %L, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('bom_fg3', 'bom_id'), rls_test.id('w1'), rls_test.id('w1'), rls_test.today(), rls_test.today() + 5), 'differs');
select rls_test.expect_call_error('unit: the unit-mismatched BOM cannot be re-approved either (new version)',
  format($q$ select public.production_bom_action((public.production_new_bom_version(%L, gen_random_uuid()) ->> 'bom_id')::uuid, 'SUBMIT') $q$,
    rls_test.gid('bom_fg3', 'bom_id')), 'does not match the inventory unit');

-- ===========================================================================
-- 6. PRODUCTION ORDERS: creation and server-validated transitions
-- ===========================================================================
select rls_test.claims('viewer');
select rls_test.expect_call_error('order: Management Viewer cannot create production orders',
  format($q$ select public.production_save_order(null, %L, 10, %L, %L, %L, %L, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('bom1', 'bom_id'), rls_test.id('w1'), rls_test.id('w1'), rls_test.today(), rls_test.today() + 5), 'not allowed');
select rls_test.claims('pm');
select rls_test.expect_call_error('order: target date before start date is rejected',
  format($q$ select public.production_save_order(null, %L, 10, %L, %L, %L, %L, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('bom1', 'bom_id'), rls_test.id('w1'), rls_test.id('w1'), rls_test.today(), rls_test.today() - 1), 'target completion');
select rls_test.expect_call_ok('order: Production Manager creates P1 (10 units, BOM v1)', 'p1',
  format($q$ select public.production_save_order(null, %L, 10, %L, %L, %L, %L, 'HIGH', 'First run', 'e7e5f200-0000-4000-8000-000000000010') $q$,
    rls_test.gid('bom1', 'bom_id'), rls_test.id('w1'), rls_test.id('w1'), rls_test.today(), rls_test.today() + 5));
select rls_test.set('p1_dup', rls_test.call(format($q$ select public.production_save_order(null, %L, 10, %L, %L, %L, %L, 'HIGH', 'First run', 'e7e5f200-0000-4000-8000-000000000010') $q$,
  rls_test.gid('bom1', 'bom_id'), rls_test.id('w1'), rls_test.id('w1'), rls_test.today(), rls_test.today() + 5)));
select rls_test.ok('order: a repeated create request (same request id) does not create a second order',
  rls_test.gid('p1_dup', 'order_id') = rls_test.gid('p1', 'order_id')
  and (select count(*) = 1 from public.production_orders where company_id = rls_test.id('company_a')), rls_test.get('p1_dup')::text);
select rls_test.ok('order: material plan snapshotted from the BOM (clay 25, glaze 2.2, cartons 10)',
  (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('clay'))).planned_quantity = 25
  and (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('glaze'))).planned_quantity = 2.2
  and (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('box'))).planned_quantity = 10
  and (rls_test.order_row(rls_test.gid('p1', 'order_id'))).bom_version = 1);
select rls_test.ok('order: creating an order moves and reserves no stock',
  rls_test.on_hand(rls_test.id('clay')) = 100 and rls_test.reserved(rls_test.id('clay')) = 0);
select rls_test.expect_call_error('order: a draft cannot be started', format($q$ select public.production_order_action(%L, 'START') $q$, rls_test.gid('p1', 'order_id')), 'Only approved');
select rls_test.expect_call_error('order: a draft cannot be completed', format($q$ select public.production_order_action(%L, 'COMPLETE') $q$, rls_test.gid('p1', 'order_id')), 'Only orders in production');
select rls_test.expect_call_error('order: materials cannot be reserved for a draft', format($q$ select public.production_reserve_materials(%L, false, gen_random_uuid()) $q$, rls_test.gid('p1', 'order_id')), 'approved');
select rls_test.expect_error('order: clients cannot change the status directly',
  format($q$ update public.production_orders set status = 'COMPLETED' where id = %L $q$, rls_test.gid('p1', 'order_id')));
select rls_test.expect_call_ok('order: creator submits P1', 'p1_submit', format($q$ select public.production_order_action(%L, 'SUBMIT') $q$, rls_test.gid('p1', 'order_id')));
select rls_test.expect_call_error('order: creator cannot approve own order', format($q$ select public.production_order_action(%L, 'APPROVE') $q$, rls_test.gid('p1', 'order_id')), 'Segregation of duties');
select rls_test.claims('im');
select rls_test.expect_call_error('order: Inventory Manager cannot approve orders', format($q$ select public.production_order_action(%L, 'APPROVE') $q$, rls_test.gid('p1', 'order_id')), 'not allowed');
select rls_test.claims('pm2');
select rls_test.expect_call_ok('order: second Production Manager approves P1', 'p1_approve', format($q$ select public.production_order_action(%L, 'APPROVE') $q$, rls_test.gid('p1', 'order_id')));
select rls_test.ok('order: P1 is APPROVED with approver recorded',
  (rls_test.order_row(rls_test.gid('p1', 'order_id'))).status = 'APPROVED' and (rls_test.order_row(rls_test.gid('p1', 'order_id'))).approved_by = rls_test.id('pm2'));
select rls_test.expect_call_error('order: approving twice is rejected', format($q$ select public.production_order_action(%L, 'APPROVE') $q$, rls_test.gid('p1', 'order_id')), 'not awaiting approval');

-- Reject path
select rls_test.claims('pm');
select rls_test.set('p2', rls_test.call(format($q$ select public.production_save_order(null, %L, 40, %L, %L, %L, %L, p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.gid('bom1', 'bom_id'), rls_test.id('w1'), rls_test.id('w1'), rls_test.today(), rls_test.today() + 5)));
select rls_test.call(format($q$ select public.production_order_action(%L, 'SUBMIT') $q$, rls_test.gid('p2', 'order_id')));
select rls_test.claims('pm2');
select rls_test.expect_call_error('order: rejection requires a reason', format($q$ select public.production_order_action(%L, 'REJECT') $q$, rls_test.gid('p2', 'order_id')), 'reason');
select rls_test.expect_call_ok('order: rejected order returns to draft with the reason', 'p2_reject',
  format($q$ select public.production_order_action(%L, 'REJECT', 'Plan for next week') $q$, rls_test.gid('p2', 'order_id')));
select rls_test.ok('order: rejected order is DRAFT with review note',
  (rls_test.order_row(rls_test.gid('p2', 'order_id'))).status = 'DRAFT' and (rls_test.order_row(rls_test.gid('p2', 'order_id'))).review_note = 'Plan for next week');
select rls_test.claims('pm');
select rls_test.call(format($q$ select public.production_order_action(%L, 'SUBMIT') $q$, rls_test.gid('p2', 'order_id')));
select rls_test.claims('pm2');
select rls_test.call(format($q$ select public.production_order_action(%L, 'APPROVE') $q$, rls_test.gid('p2', 'order_id')));

-- ===========================================================================
-- 7-8. RESERVATIONS against actual stock; competing orders
-- ===========================================================================
select rls_test.claims('viewer');
select rls_test.expect_call_error('reserve: Management Viewer cannot reserve materials',
  format($q$ select public.production_reserve_materials(%L, false, gen_random_uuid()) $q$, rls_test.gid('p1', 'order_id')), 'not allowed');
select rls_test.claims('pm');
select rls_test.expect_call_ok('reserve: P1 reserves its full material requirement', 'p1_res',
  format($q$ select public.production_reserve_materials(%L, false, 'e7e5f200-0000-4000-8000-000000000020') $q$, rls_test.gid('p1', 'order_id')));
select rls_test.ok('reserve: balances reserved exactly (clay 25, glaze 2.2, cartons 10) and P1 is MATERIALS_RESERVED',
  rls_test.reserved(rls_test.id('clay')) = 25 and rls_test.reserved(rls_test.id('glaze')) = 2.2 and rls_test.reserved(rls_test.id('box')) = 10
  and rls_test.on_hand(rls_test.id('clay')) = 100 and (rls_test.order_row(rls_test.gid('p1', 'order_id'))).status = 'MATERIALS_RESERVED');
select rls_test.ok('reserve: reservations are recorded in the existing stock_reservations table with lot and location',
  (select count(*) = 3 and bool_and(batch_id is not null and location_id = rls_test.id('g1') and reference_number = 'PRD-000001')
   from public.stock_reservations where reference_type = 'PRODUCTION_ORDER' and reference_id = rls_test.gid('p1', 'order_id')));
select rls_test.set('p1_res_dup', rls_test.call(format($q$ select public.production_reserve_materials(%L, false, 'e7e5f200-0000-4000-8000-000000000020') $q$, rls_test.gid('p1', 'order_id'))));
select rls_test.ok('reserve: a retried reservation request reserves nothing more', rls_test.reserved(rls_test.id('clay')) = 25
  and (rls_test.get('p1_res_dup') ->> 'duplicate') = 'true');
select rls_test.claims('im');
select rls_test.expect_call_error('reserve: production reservations cannot be released from the generic reservations page',
  format($q$ select public.inventory_release_reservation((select id from public.stock_reservations where reference_id = %L limit 1)) $q$, rls_test.gid('p1', 'order_id')), 'production order');
select rls_test.expect_call_error('reserve: production reservations cannot be fulfilled by a generic issue',
  format($q$ select public.inventory_fulfil_reservation((select id from public.stock_reservations where reference_id = %L limit 1), 1, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('p1', 'order_id')), 'production order');

-- Competing order P2 needs 100 KG clay; only 75 are unreserved.
select rls_test.claims('pm');
select rls_test.expect_call_error('reserve: P2 cannot reserve more clay than is available; nothing is reserved',
  format($q$ select public.production_reserve_materials(%L, false, gen_random_uuid()) $q$, rls_test.gid('p2', 'order_id')), 'short by 25');
select rls_test.ok('reserve: the failed all-or-nothing reservation left balances unchanged',
  rls_test.reserved(rls_test.id('clay')) = 25 and rls_test.open_res(rls_test.gid('p2', 'order_id')) = 0);
select rls_test.expect_call_ok('reserve: P2 partial reservation takes only the 75 KG still available', 'p2_res',
  format($q$ select public.production_reserve_materials(%L, true, gen_random_uuid()) $q$, rls_test.gid('p2', 'order_id')));
select rls_test.ok('reserve: P2 got 75 KG clay, reports the 25 KG shortage and stays APPROVED (not fully reserved)',
  rls_test.reserved(rls_test.id('clay')) = 100 and (rls_test.get('p2_res') ->> 'fully_reserved') = 'false'
  and (rls_test.order_row(rls_test.gid('p2', 'order_id'))).status = 'APPROVED', rls_test.get('p2_res')::text);
select rls_test.ok('reserve: reserved never exceeds on hand (competing orders cannot reserve the same units)',
  (select bool_and(reserved <= on_hand) from public.inventory_balances where company_id = rls_test.id('company_a')));
select rls_test.expect_call_ok('reserve: releasing P2 reservations restores availability', 'p2_rel',
  format($q$ select public.production_release_reservations(%L, 'Not needed yet') $q$, rls_test.gid('p2', 'order_id')));
select rls_test.ok('reserve: after release only P1 holds clay', rls_test.reserved(rls_test.id('clay')) = 25);

-- ===========================================================================
-- 9-11. MATERIAL ISSUE: exactly once, atomic, partial, over-issue control
-- ===========================================================================
select rls_test.expect_call_error('issue: materials cannot be issued before production starts',
  format($q$ select public.production_issue_materials(%L, %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('p1', 'order_id'),
    jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('clay'))).id,
      'batch_id', rls_test.id('lot_clay'), 'location_id', rls_test.id('g1'), 'quantity', 25))), 'Start production');
select rls_test.expect_call_ok('issue: P1 started', 'p1_start', format($q$ select public.production_order_action(%L, 'START') $q$, rls_test.gid('p1', 'order_id')));
select rls_test.ok('issue: starting production moved no stock', rls_test.on_hand(rls_test.id('clay')) = 100 and rls_test.ledger_count(rls_test.id('clay'), 'PRODUCTION_ISSUE') = 0);

select rls_test.claims('sales');
select rls_test.expect_call_error('issue: Sales Manager cannot issue materials',
  format($q$ select public.production_issue_materials(%L, '[]'::jsonb, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('p1', 'order_id')), 'not allowed');
select rls_test.claims('im');
select rls_test.set('issue_clay', jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('clay'))).id,
  'batch_id', rls_test.id('lot_clay'), 'location_id', rls_test.id('g1'), 'quantity', 25)));
select rls_test.expect_call_ok('issue: Inventory Manager issues 25 KG clay to P1', 'i_clay',
  format($q$ select public.production_issue_materials(%L, %L::jsonb, null, null, 'Casting', 'e7e5f200-0000-4000-8000-000000000030') $q$, rls_test.gid('p1', 'order_id'), rls_test.get('issue_clay')));
select rls_test.ok('issue: clay on hand 100 -> 75 and its reservation consumed (reserved 25 -> 0)',
  rls_test.on_hand(rls_test.id('clay')) = 75 and rls_test.reserved(rls_test.id('clay')) = 0);
select rls_test.set('i_clay_dup', rls_test.call(format($q$ select public.production_issue_materials(%L, %L::jsonb, null, null, 'Casting', 'e7e5f200-0000-4000-8000-000000000030') $q$,
  rls_test.gid('p1', 'order_id'), rls_test.get('issue_clay'))));
select rls_test.ok('issue: a retried issue (same request id) deducts nothing more — exactly one PRODUCTION_ISSUE',
  rls_test.on_hand(rls_test.id('clay')) = 75 and rls_test.ledger_count(rls_test.id('clay'), 'PRODUCTION_ISSUE') = 1
  and (rls_test.get('i_clay_dup') ->> 'duplicate') = 'true');
select rls_test.ok('issue: consumption record is linked to its ledger transaction, lot and order line',
  (select count(*) = 1 and bool_and(c.actual_quantity = 25 and c.reserved_quantity_used = 25 and t.transaction_type = 'PRODUCTION_ISSUE'
          and t.document_type = 'PRODUCTION' and t.document_id = c.production_order_id and t.batch_id = c.batch_id)
   from public.production_material_consumption c join public.inventory_transactions t on t.id = c.inventory_transaction_id
   where c.production_order_id = rls_test.gid('p1', 'order_id'))
  and (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('clay'))).issued_quantity = 25);
select rls_test.ok('issue: the fulfilled reservation is marked FULFILLED',
  (select reservation_status = 'FULFILLED' from public.stock_reservations where reference_id = rls_test.gid('p1', 'order_id') and product_id = rls_test.id('clay')));

-- Atomic failure: cartons OK + glaze far more than exists -> nothing posted.
select rls_test.expect_call_error('issue: a multi-line issue with one impossible line fails as a whole',
  format($q$ select public.production_issue_materials(%L, %L::jsonb, p_over_issue_reason => 'Test of atomicity', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('p1', 'order_id'),
    jsonb_build_array(
      jsonb_build_object('order_material_id', (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('box'))).id, 'batch_id', rls_test.id('lot_box'), 'location_id', rls_test.id('g1'), 'quantity', 10),
      jsonb_build_object('order_material_id', (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('glaze'))).id, 'batch_id', rls_test.id('lot_glaze'), 'location_id', rls_test.id('g1'), 'quantity', 2.2),
      jsonb_build_object('order_material_id', (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('clay'))).id, 'batch_id', rls_test.id('lot_clay'), 'location_id', rls_test.id('g1'), 'quantity', 500))));
select rls_test.ok('issue: failed issue rolled back completely (cartons, glaze, reservations and order lines unchanged)',
  rls_test.on_hand(rls_test.id('box')) = 50 and rls_test.reserved(rls_test.id('box')) = 10 and rls_test.on_hand(rls_test.id('glaze')) = 20
  and (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('box'))).issued_quantity = 0
  and (select count(*) = 1 from public.production_material_consumption where production_order_id = rls_test.gid('p1', 'order_id')));
select rls_test.expect_call_error('issue: materials must come from the order''s source warehouse',
  format($q$ select public.production_issue_materials(%L, %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('p1', 'order_id'),
    jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('box'))).id,
      'batch_id', rls_test.id('lot_box'), 'location_id', rls_test.id('g2'), 'quantity', 1))), 'source warehouse');
select rls_test.expect_call_error('issue: a lot of another product is rejected',
  format($q$ select public.production_issue_materials(%L, %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('p1', 'order_id'),
    jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('box'))).id,
      'batch_id', rls_test.id('lot_clay'), 'location_id', rls_test.id('g1'), 'quantity', 1))), 'does not belong');

-- Partial and multiple issues of the same component.
select rls_test.expect_call_ok('issue: glaze issued in two parts (1.0 then 1.2) and cartons in full', 'i_parts',
  format($q$ select public.production_issue_materials(%L, %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('p1', 'order_id'),
    jsonb_build_array(
      jsonb_build_object('order_material_id', (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('glaze'))).id, 'batch_id', rls_test.id('lot_glaze'), 'location_id', rls_test.id('g1'), 'quantity', 1.0),
      jsonb_build_object('order_material_id', (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('glaze'))).id, 'batch_id', rls_test.id('lot_glaze'), 'location_id', rls_test.id('g1'), 'quantity', 1.2),
      jsonb_build_object('order_material_id', (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('box'))).id, 'batch_id', rls_test.id('lot_box'), 'location_id', rls_test.id('g1'), 'quantity', 10))));
select rls_test.ok('issue: partial issues accumulate (glaze issued 2.2 over 2 records, stock 20 -> 17.8)',
  (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('glaze'))).issued_quantity = 2.2 and rls_test.on_hand(rls_test.id('glaze')) = 17.8
  and (select count(*) = 2 from public.production_material_consumption where production_order_id = rls_test.gid('p1', 'order_id') and component_product_id = rls_test.id('glaze'))
  and rls_test.reserved(rls_test.id('glaze')) = 0 and rls_test.on_hand(rls_test.id('box')) = 40);
select rls_test.expect_call_error('issue: over-consumption needs the exception permission (Inventory Manager lacks it)',
  format($q$ select public.production_issue_materials(%L, %L::jsonb, p_over_issue_reason => 'Breakage in casting', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('p1', 'order_id'),
    jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('clay'))).id,
      'batch_id', rls_test.id('lot_clay'), 'location_id', rls_test.id('g1'), 'quantity', 1))), 'production_exception.approve');
select rls_test.claims('pm');
select rls_test.expect_call_error('issue: over-consumption requires a documented reason',
  format($q$ select public.production_issue_materials(%L, %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('p1', 'order_id'),
    jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('clay'))).id,
      'batch_id', rls_test.id('lot_clay'), 'location_id', rls_test.id('g1'), 'quantity', 1))), 'reason');
select rls_test.expect_call_ok('issue: authorised over-consumption with a reason', 'i_over',
  format($q$ select public.production_issue_materials(%L, %L::jsonb, p_over_issue_reason => 'Breakage in casting', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('p1', 'order_id'),
    jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('clay'))).id,
      'batch_id', rls_test.id('lot_clay'), 'location_id', rls_test.id('g1'), 'quantity', 1))));
select rls_test.ok('issue: over-issue recorded with its reason (clay issued 26 of 25 planned)',
  (rls_test.material(rls_test.gid('p1', 'order_id'), rls_test.id('clay'))).issued_quantity = 26
  and exists (select 1 from public.production_material_consumption where production_order_id = rls_test.gid('p1', 'order_id') and over_issue_reason = 'Breakage in casting'));

-- ===========================================================================
-- 12-14. FINISHED-GOODS OUTPUT: exactly once, partial, rejects, limits, completion
-- ===========================================================================
select rls_test.claims('viewer');
select rls_test.expect_call_error('output: Management Viewer cannot record output',
  format($q$ select public.production_receive_output(%L, 1, p_good_location_id => %L, p_batch_number => 'FG-001', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('p1', 'order_id'), rls_test.id('g1')), 'not allowed');
select rls_test.claims('im');
select rls_test.expect_call_error('output: good output cannot go to a rejected-goods location',
  format($q$ select public.production_receive_output(%L, 1, p_good_location_id => %L, p_batch_number => 'FG-001', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('p1', 'order_id'), rls_test.id('rej')), 'storage location');
select rls_test.expect_call_ok('output: 4 good units received into batch FG-001', 'o1',
  format($q$ select public.production_receive_output(%L, 4, p_good_location_id => %L, p_batch_number => 'FG-001', p_quality_status => 'ACCEPTED', p_idempotency_key => 'e7e5f200-0000-4000-8000-000000000040') $q$,
    rls_test.gid('p1', 'order_id'), rls_test.id('g1')));
select rls_test.set('o1_dup', rls_test.call(format($q$ select public.production_receive_output(%L, 4, p_good_location_id => %L, p_batch_number => 'FG-001', p_quality_status => 'ACCEPTED', p_idempotency_key => 'e7e5f200-0000-4000-8000-000000000040') $q$,
  rls_test.gid('p1', 'order_id'), rls_test.id('g1'))));
select rls_test.ok('output: finished goods increase exactly once (retry with same request id adds nothing)',
  rls_test.on_hand(rls_test.id('fg')) = 4 and rls_test.ledger_count(rls_test.id('fg'), 'PRODUCTION_RECEIPT') = 1 and (rls_test.get('o1_dup') ->> 'duplicate') = 'true');
select rls_test.ok('output: output lot is IN_HOUSE batch FG-001 and P1 is PARTIALLY_COMPLETED with 4 completed',
  (select source_type = 'IN_HOUSE' and batch_number = 'FG-001' from public.inventory_batches where id = rls_test.gid('o1', 'batch_id'))
  and (rls_test.order_row(rls_test.gid('p1', 'order_id'))).completed_quantity = 4
  and (rls_test.order_row(rls_test.gid('p1', 'order_id'))).status = 'PARTIALLY_COMPLETED');
select rls_test.expect_call_error('output: rejected quantity needs a reason',
  format($q$ select public.production_receive_output(%L, 5, 1, 0, %L, %L, 'FG-001', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('p1', 'order_id'), rls_test.id('g1'), rls_test.id('rej')), 'reason');
select rls_test.expect_call_error('output: rejected goods cannot be stocked in a normal storage location',
  format($q$ select public.production_receive_output(%L, 5, 1, 0, %L, %L, 'FG-001', p_rejection_reason => 'Glaze defect', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('p1', 'order_id'), rls_test.id('g1'), rls_test.id('g2')), 'rejected');
select rls_test.expect_call_ok('output: second partial receipt — 5 good, 1 rejected (stocked as non-saleable)', 'o2',
  format($q$ select public.production_receive_output(%L, 5, 1, 0, %L, %L, 'FG-001', p_rejection_reason => 'Glaze defect', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('p1', 'order_id'), rls_test.id('g1'), rls_test.id('rej')));
select rls_test.ok('output: good and rejected kept distinct — 9 good in storage, 1 in the rejected bay',
  rls_test.on_hand(rls_test.id('fg'), rls_test.id('g1')) = 9 and rls_test.on_hand(rls_test.id('fg'), rls_test.id('rej')) = 1
  and (rls_test.order_row(rls_test.gid('p1', 'order_id'))).completed_quantity = 9 and (rls_test.order_row(rls_test.gid('p1', 'order_id'))).rejected_quantity = 1);
reset role;
select rls_test.ok('output: rejected goods are not sellable/available (available counts storage only)',
  (select on_hand = 10 and available = 9 from public.inventory_product_stock where product_id = rls_test.id('fg'))
  and (select rejected_on_hand = 1 from public.inventory_product_usage_stock where product_id = rls_test.id('fg')));
set local role authenticated;
select rls_test.claims('im');
select rls_test.expect_call_error('output: over-production needs the exception permission',
  format($q$ select public.production_receive_output(%L, 1, p_good_location_id => %L, p_batch_number => 'FG-001', p_over_production_reason => 'Extra moulds', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('p1', 'order_id'), rls_test.id('g1')), 'production_exception.approve');
select rls_test.claims('pm');
select rls_test.expect_call_error('output: over-production requires a documented reason',
  format($q$ select public.production_receive_output(%L, 1, p_good_location_id => %L, p_batch_number => 'FG-001', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('p1', 'order_id'), rls_test.id('g1')), 'reason');
select rls_test.expect_call_error('order: an order with posted issues cannot be cancelled',
  format($q$ select public.production_order_action(%L, 'CANCEL', 'Mistake') $q$, rls_test.gid('p1', 'order_id')), 'cannot be cancelled');
select rls_test.claims('im');
select rls_test.expect_call_error('order: Inventory Manager cannot complete orders',
  format($q$ select public.production_order_action(%L, 'COMPLETE') $q$, rls_test.gid('p1', 'order_id')), 'not allowed');

-- P3: output before material issue, discrepancy-controlled completion.
select rls_test.claims('pm');
select rls_test.set('p3', rls_test.call(format($q$ select public.production_save_order(null, %L, 10, %L, %L, %L, %L, p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.gid('bom1', 'bom_id'), rls_test.id('w1'), rls_test.id('w1'), rls_test.today(), rls_test.today() + 5)));
select rls_test.call(format($q$ select public.production_order_action(%L, 'SUBMIT') $q$, rls_test.gid('p3', 'order_id')));
select rls_test.claims('pm2');
select rls_test.call(format($q$ select public.production_order_action(%L, 'APPROVE') $q$, rls_test.gid('p3', 'order_id')));
select rls_test.call(format($q$ select public.production_order_action(%L, 'START') $q$, rls_test.gid('p3', 'order_id')));
select rls_test.expect_call_error('output: output cannot be recorded before any material is issued',
  format($q$ select public.production_receive_output(%L, 5, p_good_location_id => %L, p_batch_number => 'FG-003', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('p3', 'order_id'), rls_test.id('g1')), 'Issue materials');
select rls_test.call(format($q$ select public.production_issue_materials(%L, %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('p3', 'order_id'),
  jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.material(rls_test.gid('p3', 'order_id'), rls_test.id('clay'))).id,
    'batch_id', rls_test.id('lot_clay'), 'location_id', rls_test.id('g1'), 'quantity', 10))));
select rls_test.call(format($q$ select public.production_receive_output(%L, 5, p_good_location_id => %L, p_batch_number => 'FG-003', p_idempotency_key => gen_random_uuid()) $q$,
  rls_test.gid('p3', 'order_id'), rls_test.id('g1')));
select rls_test.expect_call_error('complete: discrepancies (output short, materials under-issued) need a documented exception',
  format($q$ select public.production_order_action(%L, 'COMPLETE') $q$, rls_test.gid('p3', 'order_id')), 'discrepancies');
select rls_test.expect_call_ok('complete: authorised completion with a documented reason', 'p3_complete',
  format($q$ select public.production_order_action(%L, 'COMPLETE', 'Kiln failure, remaining run cancelled') $q$, rls_test.gid('p3', 'order_id')));
select rls_test.ok('complete: the discrepancies were recorded (OUTPUT_SHORT and MATERIAL_UNDER_ISSUED)',
  (select string_agg(d ->> 'type', ',' order by d ->> 'type') from jsonb_array_elements(rls_test.get('p3_complete') -> 'discrepancies') d)
    = 'MATERIAL_UNDER_ISSUED,MATERIAL_UNDER_ISSUED,MATERIAL_UNDER_ISSUED,OUTPUT_SHORT'
  and (select (d ->> 'expected')::numeric = 12.5 from jsonb_array_elements(rls_test.get('p3_complete') -> 'discrepancies') d where d ->> 'sku' = 'PRD-CLAY'),
  rls_test.get('p3_complete')::text);

-- P1 completes cleanly (output 10 = plan, every component issued at least the standard).
select rls_test.claims('pm');
select rls_test.expect_call_ok('complete: P1 completes without exception (output and materials consistent)', 'p1_complete',
  format($q$ select public.production_order_action(%L, 'COMPLETE') $q$, rls_test.gid('p1', 'order_id')));
select rls_test.ok('complete: P1 is COMPLETED with completion date and no discrepancies',
  (rls_test.order_row(rls_test.gid('p1', 'order_id'))).status = 'COMPLETED'
  and (rls_test.order_row(rls_test.gid('p1', 'order_id'))).actual_completion_date = rls_test.today()
  and jsonb_array_length(rls_test.get('p1_complete') -> 'discrepancies') = 0);
select rls_test.expect_call_error('complete: no more output after completion',
  format($q$ select public.production_receive_output(%L, 1, p_good_location_id => %L, p_batch_number => 'FG-001', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('p1', 'order_id'), rls_test.id('g1')), 'in production');
select rls_test.ok('history: every step of P1 is in its event history',
  (select count(*) >= 9 from public.production_order_events where production_order_id = rls_test.gid('p1', 'order_id')));

-- BOM versioning: v2 closes v1; P1 keeps v1; new orders must use v2.
select rls_test.expect_call_ok('version: new BOM version 2 created from v1', 'bom1_v2',
  format($q$ select public.production_new_bom_version(%L, gen_random_uuid()) $q$, rls_test.gid('bom1', 'bom_id')));
select rls_test.call(format($q$ select public.production_bom_action(%L, 'SUBMIT') $q$, rls_test.gid('bom1_v2', 'bom_id')));
select rls_test.claims('pm2');
select rls_test.expect_call_ok('version: v2 approved', 'bom1_v2_ok', format($q$ select public.production_bom_action(%L, 'APPROVE') $q$, rls_test.gid('bom1_v2', 'bom_id')));
select rls_test.ok('version: approving v2 closes v1 the day before v2 starts',
  (select effective_to = rls_test.today() - 1 from public.boms where id = rls_test.gid('bom1', 'bom_id'))
  and (select version = 2 from public.boms where id = rls_test.gid('bom1_v2', 'bom_id')));
select rls_test.ok('version: existing orders keep the BOM version they were created with',
  (rls_test.order_row(rls_test.gid('p1', 'order_id'))).bom_version = 1 and (rls_test.order_row(rls_test.gid('p1', 'order_id'))).bom_id = rls_test.gid('bom1', 'bom_id'));
select rls_test.claims('pm');
select rls_test.expect_call_error('version: a superseded BOM version cannot be used for a new order',
  format($q$ select public.production_save_order(null, %L, 5, %L, %L, %L, %L, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('bom1', 'bom_id'), rls_test.id('w1'), rls_test.id('w1'), rls_test.today(), rls_test.today() + 5), 'not approved and currently effective');

-- ===========================================================================
-- 15-18. OUTSOURCING: dispatch, external location, partial receipts, rejects,
--        no double counting of company material
-- ===========================================================================
select rls_test.claims('pur');
select rls_test.expect_call_error('outsourcing: processing order needs the external-processing location',
  format($q$ select public.outsourcing_save_order(null, 'OUTSOURCED_PROCESSING', %L, null, 10, 'Test Processor', null, %L, %L, %L, p_materials => %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.id('semi'), rls_test.today() + 10, rls_test.id('w1'), rls_test.id('g1'), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('clay'), 'quantity', 20))), 'external-processing');
select rls_test.expect_call_error('outsourcing: processing order needs company materials',
  format($q$ select public.outsourcing_save_order(null, 'OUTSOURCED_PROCESSING', %L, null, 10, 'Test Processor', null, %L, %L, %L, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.id('semi'), rls_test.today() + 10, rls_test.id('w1'), rls_test.id('ext')), 'materials');
select rls_test.expect_call_ok('outsourcing: Purchase Manager creates processing order O1 (10 blanks from 20 KG clay)', 'o1o',
  format($q$ select public.outsourcing_save_order(null, 'OUTSOURCED_PROCESSING', %L, null, 10, 'Test Processor', 'JW-17', %L, %L, %L, 'CH-1', 30, null, %L::jsonb, 'e7e5f200-0000-4000-8000-000000000050') $q$,
    rls_test.id('semi'), rls_test.today() + 10, rls_test.id('w1'), rls_test.id('ext'), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('clay'), 'quantity', 20))));
select rls_test.ok('outsourcing: supplier recorded as a controlled reference (supplier master pending: supplier_id null)',
  (rls_test.oorder(rls_test.gid('o1o', 'order_id'))).supplier_id is null and (rls_test.oorder(rls_test.gid('o1o', 'order_id'))).supplier_name = 'Test Processor');
select rls_test.call(format($q$ select public.outsourcing_order_action(%L, 'SUBMIT') $q$, rls_test.gid('o1o', 'order_id')));
select rls_test.expect_call_error('outsourcing: creator cannot approve own outsourcing order',
  format($q$ select public.outsourcing_order_action(%L, 'APPROVE') $q$, rls_test.gid('o1o', 'order_id')), 'Segregation of duties');
select rls_test.claims('adm');
select rls_test.expect_call_ok('outsourcing: Admin approves O1', 'o1o_ok', format($q$ select public.outsourcing_order_action(%L, 'APPROVE') $q$, rls_test.gid('o1o', 'order_id')));
select rls_test.claims('pur');
select rls_test.expect_call_error('outsourcing: Purchase Manager cannot dispatch stock (stores permission)',
  format($q$ select public.outsourcing_move_materials(%L, 'DISPATCH', '[]'::jsonb, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('o1o', 'order_id')), 'not allowed');

select rls_test.claims('im');
select rls_test.set('clay_total_before', to_jsonb(rls_test.on_hand(rls_test.id('clay'))));
select rls_test.set('dispatch_lines', jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.omaterial(rls_test.gid('o1o', 'order_id'), rls_test.id('clay'))).id,
  'batch_id', rls_test.id('lot_clay'), 'location_id', rls_test.id('g1'), 'quantity', 20)));
select rls_test.expect_call_ok('outsourcing: Inventory Manager dispatches 20 KG clay to the processor', 'disp1',
  format($q$ select public.outsourcing_move_materials(%L, 'DISPATCH', %L::jsonb, p_idempotency_key => 'e7e5f200-0000-4000-8000-000000000060') $q$,
    rls_test.gid('o1o', 'order_id'), rls_test.get('dispatch_lines')));
select rls_test.call(format($q$ select public.outsourcing_move_materials(%L, 'DISPATCH', %L::jsonb, p_idempotency_key => 'e7e5f200-0000-4000-8000-000000000060') $q$,
  rls_test.gid('o1o', 'order_id'), rls_test.get('dispatch_lines')));
select rls_test.ok('outsourcing: dispatch is a transfer — company clay unchanged, 20 KG now at the external location (retry ignored)',
  rls_test.on_hand(rls_test.id('clay')) = (rls_test.get('clay_total_before'))::numeric
  and rls_test.on_hand(rls_test.id('clay'), rls_test.id('ext')) = 20
  and (rls_test.omaterial(rls_test.gid('o1o', 'order_id'), rls_test.id('clay'))).dispatched_quantity = 20
  and (rls_test.oorder(rls_test.gid('o1o', 'order_id'))).status = 'MATERIALS_DISPATCHED');
select rls_test.ok('outsourcing: dispatch posted TRANSFER_OUT/IN of the same lot (ownership and source unchanged), no consumption or purchase',
  (select count(*) = 2 and bool_and(batch_id = rls_test.id('lot_clay') and document_type = 'OUTSOURCING' and source_type = 'OUTSOURCED')
   from public.inventory_transactions where document_id = rls_test.gid('o1o', 'order_id') and transaction_type in ('TRANSFER_OUT', 'TRANSFER_IN'))
  and rls_test.ledger_count(rls_test.id('clay'), 'SUBCONTRACT_CONSUMPTION') = 0);
reset role;
select rls_test.ok('outsourcing: material held by the supplier is not available for use',
  (select available = on_hand - reserved - 20 from public.inventory_product_stock where product_id = rls_test.id('clay')));
set local role authenticated;
select rls_test.expect_call_error('outsourcing: generic transfers cannot move stock to an external-processing location',
  format($q$ select public.inventory_transfer_stock(%L, %L, %L, 1, p_source_type => 'OUTSOURCED', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.id('clay'), rls_test.id('g1'), rls_test.id('ext')), 'external-processing');
select rls_test.expect_call_error('outsourcing: generic issues cannot take stock from the supplier location',
  format($q$ select public.inventory_post_issue(%L, %L, 1, p_source_type => 'OUTSOURCED', p_reason => 'x', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.id('clay'), rls_test.id('ext')), 'external-processing');
select rls_test.expect_call_error('outsourcing: generic reversal of an outsourcing transaction is refused',
  format($q$ select public.inventory_reverse_transaction((select id from public.inventory_transactions where document_id = %L limit 1), 'Undo', gen_random_uuid()) $q$,
    rls_test.gid('o1o', 'order_id')), 'outsourcing order');
select rls_test.expect_call_error('outsourcing: generic reversal of a production transaction is refused',
  format($q$ select public.inventory_reverse_transaction((select inventory_transaction_id from public.production_material_consumption where production_order_id = %L limit 1), 'Undo', gen_random_uuid()) $q$,
    rls_test.gid('p1', 'order_id')), 'production order');

-- Receipts
select rls_test.expect_call_error('receipt: accepted + rejected cannot exceed received',
  format($q$ select public.outsourcing_receive_goods(%L, 6, 6, 1, %L, p_rejection_disposition => 'RETURN_TO_SUPPLIER', p_rejection_reason => 'Cracks', p_consumption => %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('o1o', 'order_id'), rls_test.id('g1'),
    jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.omaterial(rls_test.gid('o1o', 'order_id'), rls_test.id('clay'))).id, 'batch_id', rls_test.id('lot_clay'), 'quantity', 12))), 'cannot exceed');
select rls_test.expect_call_error('receipt: processed goods require the material the supplier used',
  format($q$ select public.outsourcing_receive_goods(%L, 6, 5, 1, %L, p_rejection_disposition => 'RETURN_TO_SUPPLIER', p_rejection_reason => 'Cracks', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('o1o', 'order_id'), rls_test.id('g1')), 'material the supplier used');
select rls_test.expect_call_error('receipt: consumption cannot exceed material held at the supplier',
  format($q$ select public.outsourcing_receive_goods(%L, 6, 6, 0, %L, p_consumption => %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('o1o', 'order_id'), rls_test.id('g1'),
    jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.omaterial(rls_test.gid('o1o', 'order_id'), rls_test.id('clay'))).id, 'batch_id', rls_test.id('lot_clay'), 'quantity', 25))), 'exceeds');
select rls_test.set('rcpt1_args', jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.omaterial(rls_test.gid('o1o', 'order_id'), rls_test.id('clay'))).id,
  'batch_id', rls_test.id('lot_clay'), 'quantity', 12)));
select rls_test.expect_call_ok('receipt: first partial receipt — 6 received, 5 accepted, 1 rejected (returned), 12 KG clay used', 'orc1',
  format($q$ select public.outsourcing_receive_goods(%L, 6, 5, 1, %L, null, null, null, null, null, 30, 'DC-1', 'RETURN_TO_SUPPLIER', 'Cracks', null, %L::jsonb, null, 'e7e5f200-0000-4000-8000-000000000070') $q$,
    rls_test.gid('o1o', 'order_id'), rls_test.id('g1'), rls_test.get('rcpt1_args')));
select rls_test.call(format($q$ select public.outsourcing_receive_goods(%L, 6, 5, 1, %L, null, null, null, null, null, 30, 'DC-1', 'RETURN_TO_SUPPLIER', 'Cracks', null, %L::jsonb, null, 'e7e5f200-0000-4000-8000-000000000070') $q$,
  rls_test.gid('o1o', 'order_id'), rls_test.id('g1'), rls_test.get('rcpt1_args')));
select rls_test.ok('receipt: only accepted goods enter stock (5 blanks, OUTSOURCED lot); rejected returned goods are not stocked; retry ignored',
  rls_test.on_hand(rls_test.id('semi')) = 5
  and (select bool_and(source_type = 'OUTSOURCED') from public.inventory_balances where product_id = rls_test.id('semi'))
  and rls_test.ledger_count(rls_test.id('semi'), 'SUBCONTRACT_RECEIPT') = 1);
select rls_test.ok('receipt: no double counting — clay at the supplier 20 -> 8, company clay down by exactly the 12 KG consumed',
  rls_test.on_hand(rls_test.id('clay'), rls_test.id('ext')) = 8
  and rls_test.on_hand(rls_test.id('clay')) = (rls_test.get('clay_total_before'))::numeric - 12
  and rls_test.ledger_count(rls_test.id('clay'), 'SUBCONTRACT_CONSUMPTION') = 1
  and rls_test.ledger_count(rls_test.id('clay'), 'SUBCONTRACT_RECEIPT') = 0);
select rls_test.ok('receipt: order shows received 6 / accepted 5 / rejected 1, pending 4, PARTIALLY_RECEIVED',
  (rls_test.oorder(rls_test.gid('o1o', 'order_id'))).received_quantity = 6 and (rls_test.oorder(rls_test.gid('o1o', 'order_id'))).accepted_quantity = 5
  and (rls_test.oorder(rls_test.gid('o1o', 'order_id'))).rejected_quantity = 1 and (rls_test.oorder(rls_test.gid('o1o', 'order_id'))).status = 'PARTIALLY_RECEIVED');
select rls_test.expect_call_error('receipt: an over-receipt needs the exception permission',
  format($q$ select public.outsourcing_receive_goods(%L, 5, 5, 0, %L, p_over_receipt_reason => 'Extra pieces', p_consumption => %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('o1o', 'order_id'), rls_test.id('g1'),
    jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.omaterial(rls_test.gid('o1o', 'order_id'), rls_test.id('clay'))).id, 'batch_id', rls_test.id('lot_clay'), 'quantity', 8))), 'production_exception.approve');
select rls_test.expect_call_ok('receipt: second partial receipt of 4 with the remaining 8 KG consumed', 'orc2',
  format($q$ select public.outsourcing_receive_goods(%L, 4, 4, 0, %L, p_consumption => %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('o1o', 'order_id'), rls_test.id('g1'),
    jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.omaterial(rls_test.gid('o1o', 'order_id'), rls_test.id('clay'))).id, 'batch_id', rls_test.id('lot_clay'), 'quantity', 8))));
select rls_test.ok('receipt: nothing left at the supplier; 9 blanks in stock',
  rls_test.on_hand(rls_test.id('clay'), rls_test.id('ext')) = 0 and rls_test.on_hand(rls_test.id('semi')) = 9);

-- Outsourced finished goods with rejects held in the rejected bay.
select rls_test.claims('pur');
select rls_test.expect_call_ok('outsourcing: finished-goods order O2 (no company material)', 'o2o',
  format($q$ select public.outsourcing_save_order(null, 'OUTSOURCED_FINISHED_GOODS', %L, null, 3, 'Basin Maker', null, %L, %L, p_unit_cost => 100, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.id('fg2'), rls_test.today() + 10, rls_test.id('w1')));
select rls_test.call(format($q$ select public.outsourcing_order_action(%L, 'SUBMIT') $q$, rls_test.gid('o2o', 'order_id')));
select rls_test.claims('adm');
select rls_test.call(format($q$ select public.outsourcing_order_action(%L, 'APPROVE') $q$, rls_test.gid('o2o', 'order_id')));
select rls_test.claims('im');
select rls_test.expect_call_ok('outsourcing: receive 3 basins — 2 accepted, 1 rejected held for rework in the rejected bay', 'orc3',
  format($q$ select public.outsourcing_receive_goods(%L, 3, 2, 1, %L, %L, p_unit_cost => 100, p_rejection_disposition => 'HELD_FOR_REWORK', p_rejection_reason => 'Chipped rim', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('o2o', 'order_id'), rls_test.id('g1'), rls_test.id('rej')));
reset role;
select rls_test.ok('outsourcing: rejected outsourced goods are not added to sellable stock (available 2 of 3 on hand)',
  (select on_hand = 3 and available = 2 and outsourced_on_hand = 3 from public.inventory_product_stock where product_id = rls_test.id('fg2'))
  and rls_test.on_hand(rls_test.id('fg2'), rls_test.id('rej')) = 1);
set local role authenticated;
select rls_test.claims('pur');
select rls_test.expect_call_ok('outsourcing: O2 completed (all received)', 'o2_done', format($q$ select public.outsourcing_order_action(%L, 'COMPLETE') $q$, rls_test.gid('o2o', 'order_id')));

-- ===========================================================================
-- 19. TRACEABILITY
-- ===========================================================================
select rls_test.claims('pm');
select rls_test.set('trace_fg', public.production_trace_batch(rls_test.gid('o1', 'batch_id')));
select rls_test.ok('trace: finished batch FG-001 traces back to P1 and to glaze batch G-1 and the clay lot',
  (select bool_or(x ->> 'order_number' = 'PRD-000001') from jsonb_array_elements(rls_test.get('trace_fg') -> 'produced_by') x)
  and (select bool_or(m ->> 'batch_number' = 'G-1') from jsonb_array_elements(rls_test.get('trace_fg') -> 'produced_by') x, jsonb_array_elements(x -> 'materials') m)
  and (select bool_or(m ->> 'sku' = 'PRD-CLAY') from jsonb_array_elements(rls_test.get('trace_fg') -> 'produced_by') x, jsonb_array_elements(x -> 'materials') m),
  rls_test.get('trace_fg')::text);
select rls_test.ok('trace: FG-001 is fully linked (all inflow came from production receipts)',
  (rls_test.get('trace_fg') -> 'completeness' ->> 'unlinked_inflow_quantity')::numeric = 0);
select rls_test.set('trace_glaze', public.production_trace_batch(rls_test.id('lot_glaze')));
select rls_test.ok('trace: raw-material batch G-1 traces forward to P1 and its output batch FG-001',
  (select bool_or(x ->> 'order_number' = 'PRD-000001' and exists (select 1 from jsonb_array_elements(x -> 'outputs') o where o ->> 'batch_number' = 'FG-001'))
   from jsonb_array_elements(rls_test.get('trace_glaze') -> 'used_in') x), rls_test.get('trace_glaze')::text);
select rls_test.ok('trace: purchased batch G-1 is flagged as having no production/outsourcing link for its inflow',
  (rls_test.get('trace_glaze') -> 'completeness' ->> 'unlinked_inflow_quantity')::numeric = 20
  and jsonb_array_length(rls_test.get('trace_glaze') -> 'completeness' -> 'warnings') >= 1);
select rls_test.set('trace_semi', public.production_trace_batch((select batch_id from public.outsourcing_receipts where id = rls_test.gid('orc1', 'receipt_id'))));
select rls_test.ok('trace: outsourced lot links to its order, supplier and the clay consumed by the supplier; pooled lot is flagged',
  (select bool_or(x ->> 'supplier_name' = 'Test Processor' and x ->> 'kind' = 'OUTSOURCING') from jsonb_array_elements(rls_test.get('trace_semi') -> 'produced_by') x)
  and (select bool_or(m ->> 'sku' = 'PRD-CLAY') from jsonb_array_elements(rls_test.get('trace_semi') -> 'produced_by') x, jsonb_array_elements(x -> 'materials') m)
  and (rls_test.get('trace_semi') -> 'completeness' ->> 'pooled_lot')::boolean, rls_test.get('trace_semi')::text);
select rls_test.ok('trace: history lists the ledger movements of the lot', jsonb_array_length(rls_test.get('trace_fg') -> 'history') = 3);

-- ===========================================================================
-- 22. REVERSALS keep ledger, balances and documents consistent
-- ===========================================================================
select rls_test.set('p2_start', rls_test.call(format($q$ select public.production_order_action(%L, 'START') $q$, rls_test.gid('p2', 'order_id'))));
select rls_test.expect_call_ok('reversal: issue 5 KG clay to P2', 'i_p2',
  format($q$ select public.production_issue_materials(%L, %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('p2', 'order_id'),
    jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.material(rls_test.gid('p2', 'order_id'), rls_test.id('clay'))).id,
      'batch_id', rls_test.id('lot_clay'), 'location_id', rls_test.id('g1'), 'quantity', 5))));
select rls_test.set('clay_g1_before_rev', to_jsonb(rls_test.on_hand(rls_test.id('clay'), rls_test.id('g1'))));
select rls_test.claims('im');
select rls_test.expect_call_error('reversal: Inventory Manager cannot reverse production postings',
  format($q$ select public.production_reverse_consumption((select id from public.production_material_consumption where production_order_id = %L), 'Wrong lot', gen_random_uuid()) $q$,
    rls_test.gid('p2', 'order_id')), 'not allowed');
select rls_test.claims('pm');
select rls_test.expect_call_ok('reversal: Production Manager reverses the P2 issue', 'rev_i',
  format($q$ select public.production_reverse_consumption((select id from public.production_material_consumption where production_order_id = %L), 'Wrong lot', gen_random_uuid()) $q$,
    rls_test.gid('p2', 'order_id')));
select rls_test.ok('reversal: stock returned to the same lot/location, issued quantity back to 0, record marked REVERSED',
  rls_test.on_hand(rls_test.id('clay'), rls_test.id('g1')) = (rls_test.get('clay_g1_before_rev'))::numeric + 5
  and (rls_test.material(rls_test.gid('p2', 'order_id'), rls_test.id('clay'))).issued_quantity = 0
  and (select status = 'REVERSED' from public.production_material_consumption where production_order_id = rls_test.gid('p2', 'order_id')));
select rls_test.expect_call_error('reversal: a reversed issue cannot be reversed again',
  format($q$ select public.production_reverse_consumption((select id from public.production_material_consumption where production_order_id = %L), 'Again', gen_random_uuid()) $q$,
    rls_test.gid('p2', 'order_id')), 'already been reversed');
select rls_test.expect_call_error('reversal: postings of a completed order cannot be reversed',
  format($q$ select public.production_reverse_output(%L, 'Late correction', gen_random_uuid()) $q$, rls_test.gid('o1', 'receipt_id')), 'completed');
select rls_test.expect_call_ok('reversal: outsourcing receipt 2 reversed (goods out, supplier consumption restored)', 'rev_orc2',
  format($q$ select public.outsourcing_reverse_receipt(%L, 'Wrong quantity', gen_random_uuid()) $q$, rls_test.gid('orc2', 'receipt_id')));
select rls_test.ok('reversal: blanks 9 -> 5, 8 KG clay back at the supplier, order received 6 and still PARTIALLY_RECEIVED',
  rls_test.on_hand(rls_test.id('semi')) = 5 and rls_test.on_hand(rls_test.id('clay'), rls_test.id('ext')) = 8
  and (rls_test.omaterial(rls_test.gid('o1o', 'order_id'), rls_test.id('clay'))).consumed_quantity = 12
  and (rls_test.oorder(rls_test.gid('o1o', 'order_id'))).received_quantity = 6 and (rls_test.oorder(rls_test.gid('o1o', 'order_id'))).status = 'PARTIALLY_RECEIVED');
select rls_test.expect_call_ok('reversal: unused clay returned from the supplier', 'ret1',
  format($q$ select public.outsourcing_move_materials(%L, 'RETURN', %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('o1o', 'order_id'),
    jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.omaterial(rls_test.gid('o1o', 'order_id'), rls_test.id('clay'))).id,
      'batch_id', rls_test.id('lot_clay'), 'location_id', rls_test.id('g1'), 'quantity', 8))));
select rls_test.ok('reversal: nothing held at the supplier after the return', rls_test.on_hand(rls_test.id('clay'), rls_test.id('ext')) = 0
  and (rls_test.omaterial(rls_test.gid('o1o', 'order_id'), rls_test.id('clay'))).returned_quantity = 8);
reset role;
select rls_test.expect_error('reversal: posted consumption records cannot be edited (even by the owner)',
  format($q$ update public.production_material_consumption set actual_quantity = 1 where production_order_id = %L $q$, rls_test.gid('p1', 'order_id')));
select rls_test.expect_error('reversal: posted output receipts cannot be deleted (even by the owner)',
  format($q$ delete from public.production_output_receipts where production_order_id = %L $q$, rls_test.gid('p1', 'order_id')));
select rls_test.expect_error('reversal: order history cannot be changed', format($q$ delete from public.production_order_events where production_order_id = %L $q$, rls_test.gid('p1', 'order_id')));
set local role authenticated;
select rls_test.claims('im');
select rls_test.ok('reversal: ledger reconciles with balances and reservations after all postings and reversals',
  jsonb_array_length(public.inventory_reconcile() -> 'mismatches') = 0, public.inventory_reconcile()::text);

-- ===========================================================================
-- 23. DASHBOARD and REPORTS match the records
-- ===========================================================================
select rls_test.claims('viewer');
select rls_test.set('ov', public.production_overview(rls_test.today() - 30, rls_test.today(), null, null, null, 'day'));
reset role;
select rls_test.ok('dashboard: open / in-progress / completed counts equal the orders table',
  (rls_test.get('ov') ->> 'open_orders')::int = (select count(*) from public.production_orders where company_id = rls_test.id('company_a') and status not in ('COMPLETED', 'CANCELLED'))
  and (rls_test.get('ov') ->> 'in_progress_orders')::int = (select count(*) from public.production_orders where company_id = rls_test.id('company_a') and status in ('IN_PROGRESS', 'PARTIALLY_COMPLETED'))
  and (rls_test.get('ov') ->> 'completed_orders')::int = 2, rls_test.get('ov')::text);
select rls_test.ok('dashboard: finished goods produced this month = posted good output (9 + 5 = 14 PCS)',
  (select (u ->> 'good')::numeric = (select sum(good_quantity) from public.production_output_receipts where company_id = rls_test.id('company_a') and status = 'POSTED')
     and (u ->> 'good')::numeric = 14
   from jsonb_array_elements(rls_test.get('ov') -> 'produced_this_month') u where u ->> 'unit' = 'PCS'));
select rls_test.ok('dashboard: in-house vs outsourced split uses accepted outsourced receipts (5 blanks + 2 basins)',
  (select sum((x ->> 'outsourced')::numeric) = 7 and sum((x ->> 'in_house')::numeric) = 14 from jsonb_array_elements(rls_test.get('ov') -> 'source_split') x));
select rls_test.ok('dashboard: outsourcing in progress and pending approvals match',
  (rls_test.get('ov') ->> 'outsourcing_in_progress')::int = 1 and (rls_test.get('ov') ->> 'pending_order_approvals')::int = 0
  and (rls_test.get('ov') ->> 'has_records')::boolean);
select rls_test.ok('dashboard: material consumption trend excludes the reversed issue (clay 26 + 10, glaze 2.2 = 38.2 KG)',
  (select sum((x ->> 'quantity')::numeric) = 38.2 from jsonb_array_elements(rls_test.get('ov') -> 'consumption_trend') x where x ->> 'unit' = 'KG'),
  (rls_test.get('ov') -> 'consumption_trend')::text);
set local role authenticated;
select rls_test.claims('viewer');
select rls_test.ok('reports: all 14 reports run for a report reader',
  (select count(*) = 14 from unnest(array['ORDERS_SUMMARY', 'PLANNED_VS_ACTUAL', 'RAW_MATERIAL_REQUIREMENTS', 'MATERIAL_SHORTAGE',
     'PLANNED_VS_ACTUAL_CONSUMPTION', 'OUTPUT_AND_REJECTIONS', 'FINISHED_GOODS_PRODUCED', 'OUTSOURCING_REGISTER', 'MATERIALS_HELD_BY_SUPPLIERS',
     'OUTSOURCED_RECEIPTS', 'IN_HOUSE_VS_OUTSOURCED', 'BATCH_TRACEABILITY', 'COST_SUMMARY', 'VARIANCE']) r
   where not (rls_test.call(format($q$ select coalesce(jsonb_agg(x), '[]'::jsonb) from public.production_report(%L, %L, %L) x $q$,
                r, rls_test.today() - 30, rls_test.today())) ? 'error')));
select rls_test.ok('costing: P1 material cost is "cost data incomplete" because glaze G-1 has no recorded cost (never zero)',
  (select x ->> 'cost_status' = 'COST_DATA_INCOMPLETE' and x -> 'total_cost' = 'null'::jsonb and x -> 'cost_per_good_unit' = 'null'::jsonb
   from public.production_report('COST_SUMMARY', rls_test.today() - 30, rls_test.today()) x where x ->> 'order_number' = 'PRD-000001'));
select rls_test.ok('costing: P3 (only costed clay issued) has an actual material cost of 10 KG x 10 = 100 and 20 per good unit',
  (select (x ->> 'material_cost')::numeric = 100 and (x ->> 'cost_per_good_unit')::numeric = 20 and x ->> 'cost_status' = 'ACTUAL'
   from public.production_report('COST_SUMMARY', rls_test.today() - 30, rls_test.today()) x where x ->> 'order_number' = 'PRD-000003'));
select rls_test.ok('costing: outsourced basins cost = recorded price x accepted (100 x 2)',
  (select (x ->> 'outsourcing_cost')::numeric = 200 and x ->> 'cost_status' = 'ACTUAL'
   from public.production_report('COST_SUMMARY', rls_test.today() - 30, rls_test.today()) x where x ->> 'order_type' = 'OUTSOURCING' and x ->> 'sku' = 'PRD-FG2'));
select rls_test.ok('reports: material shortage report lists P2''s clay shortfall',
  (select count(*) >= 1 from public.production_report('MATERIAL_SHORTAGE', rls_test.today() - 30, rls_test.today()) x where x ->> 'sku' = 'PRD-CLAY'));
select rls_test.claims('sales');
select rls_test.expect_call_error('reports: a user without production report access is refused',
  format($q$ select coalesce(jsonb_agg(x), '[]'::jsonb) from public.production_report('ORDERS_SUMMARY', %L, %L) x $q$, rls_test.today() - 30, rls_test.today()), 'not allowed');
select rls_test.expect_rows('rls: Sales Manager sees no production orders', 'select * from public.production_orders', 0);
select rls_test.claims('viewer');
select rls_test.expect_rows('rls: Management Viewer can read production orders', 'select * from public.production_orders', 3);

-- ===========================================================================
-- 20-21. CROSS-COMPANY and UNAUTHORISED POSTING
-- ===========================================================================
select rls_test.claims('viewer');
select rls_test.expect_call_error('authz: viewer cannot receive outsourced goods',
  format($q$ select public.outsourcing_receive_goods(%L, 1, 1, 0, %L, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('o1o', 'order_id'), rls_test.id('g1')), 'not allowed');
select rls_test.expect_call_error('authz: viewer cannot run order actions', format($q$ select public.production_order_action(%L, 'HOLD', 'x') $q$, rls_test.gid('p2', 'order_id')), 'not allowed');
select rls_test.expect_error('authz: clients cannot insert production records directly',
  format($q$ insert into public.production_output_receipts (company_id, receipt_number, production_order_id, product_id, good_quantity, unit, production_date)
             values (%L, 'FGR-999999', %L, %L, 100, 'PCS', current_date) $q$, rls_test.id('company_a'), rls_test.gid('p1', 'order_id'), rls_test.id('fg')));

select rls_test.claims('b_pm');
select rls_test.expect_rows('cross-company: company B sees no company A BOMs', 'select * from public.boms', 0);
select rls_test.expect_rows('cross-company: company B sees no company A production orders', 'select * from public.production_order_list', 0);
select rls_test.expect_rows('cross-company: company B sees no company A outsourcing orders', 'select * from public.outsourcing_order_list', 0);
select rls_test.expect_call_error('cross-company: cannot plan with a company A BOM',
  format($q$ select * from public.production_bom_requirements(%L, 1) $q$, rls_test.gid('bom1_v2', 'bom_id')), 'not found');
select rls_test.expect_call_error('cross-company: cannot create an order from a company A BOM',
  format($q$ select public.production_save_order(null, %L, 1, %L, %L, %L, %L, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('bom1_v2', 'bom_id'), rls_test.id('wb'), rls_test.id('wb'), rls_test.today(), rls_test.today()), 'not found');
select rls_test.expect_call_error('cross-company: cannot run actions on a company A order',
  format($q$ select public.production_order_action(%L, 'HOLD', 'x') $q$, rls_test.gid('p2', 'order_id')), 'not found');
select rls_test.expect_call_error('cross-company: cannot issue to a company A order',
  format($q$ select public.production_issue_materials(%L, '[]'::jsonb, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('p2', 'order_id')), 'not found');
select rls_test.expect_call_error('cross-company: cannot trace a company A batch',
  format($q$ select public.production_trace_batch(%L) $q$, rls_test.id('lot_glaze')), 'not found');
select rls_test.expect_call_error('cross-company: a company B BOM cannot use company A materials',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('b_fg'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('clay'), 'quantity_required', 1))), 'not found');
select rls_test.expect_call_ok('cross-company: company B creates its own BOM (same SKU text as company A)', 'b_bom',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('b_fg'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('b_rm'), 'quantity_required', 3))));
select rls_test.ok('cross-company: document numbers are per company (company B BOM-000001)',
  (select bom_code = 'BOM-000001' from public.boms where id = rls_test.gid('b_bom', 'bom_id')));
select rls_test.ok('cross-company: company B overview shows only company B (no orders)',
  (public.production_overview(rls_test.today() - 30, rls_test.today()) ->> 'open_orders')::int = 0);

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
  raise exception 'PRODUCTION_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
