-- =============================================================================
-- PRODUCTION VERIFICATION (ALTON ERP V2, Stage 4)
--
-- Checks migration 20261105090000_production_v2.sql end to end: BOM requirement
-- and wastage calculations, the entry-form preview, order creation with
-- reservation of available stock only (no physical movement, no duplicate
-- reservations, shortages as warnings), completion with ACTUAL consumption,
-- finished goods added, rejected goods kept apart, unused reservations released,
-- no double deduction, correction by reversal and re-posting (refused when the
-- finished goods were already used, all or nothing), reopening, editing and
-- recalculating, adding missing BOM components, the Excel upload, the dashboard,
-- the stock ledger and company isolation.
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction and ALWAYS ends by raising
--   PRODUCTION_V2_VERIFICATION_RESULT passed=N failed=M
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

-- SQL builders
create function rls_test.save(p_order uuid, p_data jsonb, p_key uuid default gen_random_uuid()) returns text language sql stable as $$
  select format('select public.production_order_v2_save(%L, %L::jsonb, %L)', p_order, p_data, p_key) $$;
create function rls_test.complete(p_order uuid, p_data jsonb, p_key uuid default gen_random_uuid()) returns text language sql stable as $$
  select format('select public.production_order_v2_complete(%L, %L::jsonb, %L)', p_order, p_data, p_key) $$;
create function rls_test.correct(p_order uuid, p_reason text, p_data jsonb, p_key uuid default gen_random_uuid()) returns text language sql stable as $$
  select format('select public.production_order_v2_correct(%L, %L, %L::jsonb, %L)', p_order, p_reason, p_data, p_key) $$;
create function rls_test.grn(p_product uuid, p_qty numeric, p_cost numeric) returns text language sql stable as $$
  select format('select public.goods_receipt_direct_post(%L::jsonb, %L::jsonb, %L)',
    jsonb_build_object('warehouse_id', rls_test.id('w1')),
    jsonb_build_array(jsonb_build_object('product_id', p_product, 'received_quantity', p_qty, 'accepted_quantity', p_qty, 'unit_cost', p_cost,
      'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()) $$;

-- Owner-side probes (bypass RLS).
create function rls_test.ord(p_id uuid) returns public.production_orders language sql stable security definer as $$ select * from public.production_orders where id = p_id $$;
create function rls_test.on_hand(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(on_hand), 0) from public.inventory_balances where product_id = p_product $$;
create function rls_test.reserved_total(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(reserved), 0) from public.inventory_balances where product_id = p_product $$;
create function rls_test.res(p_order uuid, p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(quantity - fulfilled_quantity - released_quantity), 0) from public.stock_reservations
  where reference_type = 'PRODUCTION_ORDER' and reference_id = p_order and product_id = p_product and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') $$;
create function rls_test.mat(p_order uuid, p_product uuid) returns uuid language sql stable security definer as $$
  select id from public.production_order_materials where production_order_id = p_order and component_product_id = p_product $$;
create function rls_test.planned(p_order uuid, p_product uuid) returns numeric language sql stable security definer as $$
  select planned_quantity from public.production_order_materials where production_order_id = p_order and component_product_id = p_product $$;
create function rls_test.tx_count(p_company uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.inventory_transactions where company_id = p_company $$;
create function rls_test.events(p_order uuid) returns text[] language sql stable security definer as $$
  select array_agg(event_type order by created_at, id) from public.production_order_events where production_order_id = p_order $$;
create function rls_test.outputs(p_order uuid, p_status text) returns bigint language sql stable security definer as $$
  select count(*) from public.production_output_receipts where production_order_id = p_order and status = p_status $$;
create function rls_test.consumption(p_order uuid, p_status text) returns bigint language sql stable security definer as $$
  select count(*) from public.production_material_consumption where production_order_id = p_order and status = p_status $$;
create function rls_test.ledger_consistent(p_company uuid) returns boolean language sql stable security definer as $$
  select not exists (
    select 1 from public.inventory_balances b
    where b.company_id = p_company
      and (b.on_hand <> coalesce((select sum(t.direction * t.quantity) from public.inventory_transactions t where t.batch_id = b.batch_id and t.location_id = b.location_id), 0)
           or b.reserved <> coalesce((select sum(r.quantity - r.fulfilled_quantity - r.released_quantity) from public.stock_reservations r
                                      where r.batch_id = b.batch_id and r.location_id = b.location_id and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')), 0))) $$;
create function rls_test.line(p_result jsonb, p_sku text) returns jsonb language sql immutable as $$
  select l from jsonb_array_elements(coalesce(p_result -> 'lines', p_result -> 'requirements', '[]'::jsonb)) l where l ->> 'sku' = p_sku $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5c500-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5c500-0000-4000-8000-0000000000b1'),
  ('op', 'e7e5c500-0000-4000-8000-000000000001'), ('b_op', 'e7e5c500-0000-4000-8000-000000000002'),
  ('fg', 'e7e5c500-0000-4000-8000-0000000000d1'), ('ca', 'e7e5c500-0000-4000-8000-0000000000d2'), ('cb', 'e7e5c500-0000-4000-8000-0000000000d3'),
  ('rm', 'e7e5c500-0000-4000-8000-0000000000d4'), ('osc', 'e7e5c500-0000-4000-8000-0000000000d5'), ('extra', 'e7e5c500-0000-4000-8000-0000000000d6'),
  ('fg2', 'e7e5c500-0000-4000-8000-0000000000d7'), ('fg3', 'e7e5c500-0000-4000-8000-0000000000d8'), ('fgb', 'e7e5c500-0000-4000-8000-0000000000d9'),
  ('w1', 'e7e5c500-0000-4000-8000-0000000000e1'), ('wb', 'e7e5c500-0000-4000-8000-0000000000e2'),
  ('rej', 'e7e5c500-0000-4000-8000-0000000000f1');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code, gstin, legal_address) values
  (rls_test.id('company_a'), 'Production V2 A Pvt Ltd', 'Production A', 'PDA', '27AAACP1234A1Z5', 'Pune'),
  (rls_test.id('company_b'), 'Production V2 B', 'Production B', 'PDB', null, null);
insert into auth.users (id, email) select id, key || '@pd.example.invalid' from rls_test.ids where key in ('op', 'b_op');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = rls_test.id('op');
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_op');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('op'), rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('b_op'), rls_test.id('company_b'), rls_test.id('role_super_admin'));
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, track_batches, track_expiry, status, standard_cost) values
  (rls_test.id('fg'),    rls_test.id('company_a'), 'PD-FG', 'ALTON Product A', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, 'ACTIVE', null),
  (rls_test.id('ca'),    rls_test.id('company_a'), 'PD-CA', 'Component A', 'COMPONENT', 'IN_HOUSE', 'PCS', false, false, 'ACTIVE', 10),
  (rls_test.id('cb'),    rls_test.id('company_a'), 'PD-CB', 'Component B', 'COMPONENT', 'IN_HOUSE', 'PCS', false, false, 'ACTIVE', 5),
  (rls_test.id('rm'),    rls_test.id('company_a'), 'PD-RM', 'Raw Material A', 'RAW_MATERIAL', 'OUTSOURCED', 'KG', false, false, 'ACTIVE', 20),
  (rls_test.id('osc'),   rls_test.id('company_a'), 'PD-OSC', 'Outsourced Component A', 'OUTSOURCED_COMPONENT', 'OUTSOURCED', 'PCS', false, false, 'ACTIVE', 30),
  (rls_test.id('extra'), rls_test.id('company_a'), 'PD-EXTRA', 'Packing carton', 'PACKAGING_MATERIAL', 'OUTSOURCED', 'PCS', false, false, 'ACTIVE', 1),
  (rls_test.id('fg2'),   rls_test.id('company_a'), 'PD-FG2', 'Product without BOM', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, 'ACTIVE', null),
  (rls_test.id('fg3'),   rls_test.id('company_a'), 'PD-FG3', 'Kit using Product A', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, 'ACTIVE', null),
  (rls_test.id('fgb'),   rls_test.id('company_b'), 'PD-FG', 'B product', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, 'ACTIVE', null);
insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Factory', true), (rls_test.id('wb'), rls_test.id('company_b'), 'W1', 'B factory', true);
insert into public.inventory_locations (id, company_id, warehouse_id, location_code, location_name, location_type, stock_usage) values
  (rls_test.id('rej'), rls_test.id('company_a'), rls_test.id('w1'), 'REJECT', 'Rejected bay', 'AREA', 'REJECTED');
insert into rls_test.ids (key, id)
select case warehouse_id when rls_test.id('w1') then 'g1' else 'gb' end, id
from public.inventory_locations where location_code = 'GENERAL' and warehouse_id in (rls_test.id('w1'), rls_test.id('wb'));

-- Stock received through goods receipts; BOM v1 of PD-FG (spec example plus wastage).
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('setup: receive 150 PD-CA @10', 'g_ca', rls_test.grn(rls_test.id('ca'), 150, 10));
select rls_test.expect_call_ok('setup: receive 250 PD-CB @5', 'g_cb', rls_test.grn(rls_test.id('cb'), 250, 5));
select rls_test.expect_call_ok('setup: receive 40 KG PD-RM @20', 'g_rm', rls_test.grn(rls_test.id('rm'), 40, 20));
select rls_test.expect_call_ok('setup: receive 100 PD-OSC @30', 'g_osc', rls_test.grn(rls_test.id('osc'), 100, 30));
select rls_test.expect_call_ok('setup: receive 20 PD-EXTRA @1', 'g_extra', rls_test.grn(rls_test.id('extra'), 20, 1));
select rls_test.expect_call_ok('setup: BOM of PD-FG: A 1, B 2 (+2%), raw 0.5 KG (+10%), outsourced 1', 'bom1',
  format('select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, %L)', rls_test.id('fg'), rls_test.today(),
    jsonb_build_array(
      jsonb_build_object('component_product_id', rls_test.id('ca'), 'quantity_required', 1),
      jsonb_build_object('component_product_id', rls_test.id('cb'), 'quantity_required', 2, 'wastage_percentage', 2),
      jsonb_build_object('component_product_id', rls_test.id('rm'), 'quantity_required', 0.5, 'wastage_percentage', 10),
      jsonb_build_object('component_product_id', rls_test.id('osc'), 'quantity_required', 1)), gen_random_uuid()));
select rls_test.expect_call_ok('setup: activate the BOM', 'bom1_act', format('select public.production_bom_activate(%L, null)', rls_test.gid('bom1', 'bom_id')));
reset role;
select rls_test.set('tx0', to_jsonb(rls_test.tx_count(rls_test.id('company_a'))));

-- ---------------------------------------------------------------------------
-- 1. Automatic BOM calculation (preview never moves or reserves stock)
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('preview: 100 units of PD-FG', 'pv', format('select public.production_v2_preview(%L, 100, null)', rls_test.id('fg')));
reset role;
select rls_test.ok('calc: active BOM fetched automatically (BOM v1, 4 components)',
  (rls_test.get('pv') -> 'bom' ->> 'version')::int = 1 and jsonb_array_length(rls_test.get('pv') -> 'lines') = 4, rls_test.get('pv')::text);
select rls_test.ok('calc: Component A 1 per unit -> 100 PCS; Component B 2 per unit +2% wastage -> 204 PCS',
  (rls_test.line(rls_test.get('pv'), 'PD-CA') ->> 'required')::numeric = 100 and (rls_test.line(rls_test.get('pv'), 'PD-CB') ->> 'required')::numeric = 204);
select rls_test.ok('calc: Raw Material A 0.5 KG per unit +10% wastage -> 55 KG (50 base + 5 wastage); outsourced component 100',
  (rls_test.line(rls_test.get('pv'), 'PD-RM') ->> 'required')::numeric = 55 and (rls_test.line(rls_test.get('pv'), 'PD-RM') ->> 'base_quantity')::numeric = 50
  and (rls_test.line(rls_test.get('pv'), 'PD-OSC') ->> 'required')::numeric = 100);
select rls_test.ok('calc: unit and source type per component (KG raw material is Purchased, outsourced component Outsourced)',
  rls_test.line(rls_test.get('pv'), 'PD-RM') ->> 'unit' = 'KG' and rls_test.line(rls_test.get('pv'), 'PD-RM') ->> 'source_type' = 'PURCHASED'
  and rls_test.line(rls_test.get('pv'), 'PD-OSC') ->> 'source_type' = 'OUTSOURCED');
select rls_test.ok('shortage: 40 KG available -> short 15 KG, shown as a purchase recommendation',
  (rls_test.line(rls_test.get('pv'), 'PD-RM') ->> 'available')::numeric = 40 and (rls_test.line(rls_test.get('pv'), 'PD-RM') ->> 'shortage')::numeric = 15
  and (rls_test.get('pv') -> 'warnings')::text ilike '%PD-RM: short by 15 KG. Purchase 15 KG%', rls_test.get('pv')::text);
select rls_test.ok('preview: nothing moved', rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx0'))::bigint);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('preview: a product without a BOM', 'pv2', format('select public.production_v2_preview(%L, 10, null)', rls_test.id('fg2')));
reset role;
select rls_test.ok('no BOM: preview warns and offers to add components', rls_test.get('pv2') -> 'bom' = 'null'::jsonb
  and (rls_test.get('pv2') -> 'warnings')::text ilike '%has no active BOM%');

-- ---------------------------------------------------------------------------
-- 2. Create a production order: reserve available stock only, never move it
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('create: a product without a BOM is refused with guidance',
  rls_test.save(null, jsonb_build_object('product_id', rls_test.id('fg2'), 'planned_quantity', 10)), 'no active BOM');
select rls_test.expect_call_ok('create: order 1, 100 units, with a raw-material shortage (not blocked)', 'o1',
  rls_test.save(null, jsonb_build_object('product_id', rls_test.id('fg'), 'planned_quantity', 100, 'production_date', rls_test.today(), 'remarks', 'First batch')));
reset role;
select rls_test.set('o1id', to_jsonb(rls_test.gid('o1', 'order_id')));
select rls_test.ok('create: automatic number PRD-…, BOM v1, opened in one step (no approval)',
  rls_test.get('o1') ->> 'production_order_number' like 'PRD-%' and (rls_test.get('o1') ->> 'bom_version')::int = 1
  and rls_test.get('o1') ->> 'status' = 'APPROVED', rls_test.get('o1')::text);
select rls_test.ok('reserve: available stock reserved for the order — A 100, B 204, raw 40 KG (all there is), outsourced 100',
  rls_test.res(rls_test.gid('o1', 'order_id'), rls_test.id('ca')) = 100 and rls_test.res(rls_test.gid('o1', 'order_id'), rls_test.id('cb')) = 204
  and rls_test.res(rls_test.gid('o1', 'order_id'), rls_test.id('rm')) = 40 and rls_test.res(rls_test.gid('o1', 'order_id'), rls_test.id('osc')) = 100);
select rls_test.ok('reserve: unavailable stock is not reserved; warning recommends purchasing 15 KG',
  (rls_test.get('o1') -> 'warnings')::text ilike '%PD-RM: short by 15 KG%' and (rls_test.line(rls_test.get('o1'), 'PD-RM') ->> 'shortage')::numeric = 15
  and (rls_test.line(rls_test.get('o1'), 'PD-RM') ->> 'reserved')::numeric = 40);
select rls_test.ok('stock: creating the order moved nothing (on hand unchanged, no ledger entries)',
  rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx0'))::bigint and rls_test.on_hand(rls_test.id('ca')) = 150 and rls_test.on_hand(rls_test.id('rm')) = 40);

set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('create: order 2, 50 units (takes what order 1 left)', 'o2',
  rls_test.save(null, jsonb_build_object('product_id', rls_test.id('fg'), 'planned_quantity', 50, 'production_date', rls_test.today())));
reset role;
select rls_test.ok('reserve: order 2 gets A 50 and B 46 (the rest); nothing reserved twice; balances never over-reserved',
  rls_test.res(rls_test.gid('o2', 'order_id'), rls_test.id('ca')) = 50 and rls_test.res(rls_test.gid('o2', 'order_id'), rls_test.id('cb')) = 46
  and rls_test.res(rls_test.gid('o2', 'order_id'), rls_test.id('rm')) = 0 and rls_test.reserved_total(rls_test.id('ca')) = 150
  and rls_test.reserved_total(rls_test.id('cb')) = 250);

set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('edit: order 1 saved again (remarks changed) — materials recalculated', 'o1e',
  rls_test.save(rls_test.gid('o1', 'order_id'), jsonb_build_object('remarks', 'First batch, line 2')));
reset role;
select rls_test.ok('no duplicate reservations: after re-saving order 1 still holds exactly A 100, B 204, raw 40',
  rls_test.res(rls_test.gid('o1', 'order_id'), rls_test.id('ca')) = 100 and rls_test.res(rls_test.gid('o1', 'order_id'), rls_test.id('cb')) = 204
  and rls_test.res(rls_test.gid('o1', 'order_id'), rls_test.id('rm')) = 40 and rls_test.reserved_total(rls_test.id('ca')) = 150
  and (rls_test.ord(rls_test.gid('o1', 'order_id'))).notes = 'First batch, line 2');

-- ---------------------------------------------------------------------------
-- 3. Completion
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('complete: refused while 15 KG raw material is missing; nothing posted',
  rls_test.complete(rls_test.gid('o1', 'order_id'), jsonb_build_object('actual_quantity', 100)), 'PD-RM needs 55 KG, short by 15');
reset role;
select rls_test.ok('complete: the failed attempt changed nothing (no ledger entries, order still open, reservations kept)',
  rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx0'))::bigint and (rls_test.ord(rls_test.gid('o1', 'order_id'))).status = 'APPROVED'
  and rls_test.res(rls_test.gid('o1', 'order_id'), rls_test.id('rm')) = 40);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('setup: receive 20 KG more raw material', 'g_rm2', rls_test.grn(rls_test.id('rm'), 20, 20));
select rls_test.set('ck', to_jsonb(gen_random_uuid()::text));
select rls_test.expect_call_ok('complete: 100 produced, 4 rejected, raw material actually used 53 KG (not the planned 55)', 'c1',
  rls_test.complete(rls_test.gid('o1', 'order_id'), jsonb_build_object('actual_quantity', 100, 'rejected_quantity', 4, 'production_date', rls_test.today(),
    'remarks', 'Shift A', 'materials', jsonb_build_array(jsonb_build_object('order_material_id', rls_test.mat(rls_test.gid('o1', 'order_id'), rls_test.id('rm')), 'quantity', 53))),
  (rls_test.get('ck') #>> '{}')::uuid));
reset role;
select rls_test.ok('deduct: actual consumption deducted — A 150->50, B 250->46, raw 60->7 KG (53 used), outsourced 100->0',
  rls_test.on_hand(rls_test.id('ca')) = 50 and rls_test.on_hand(rls_test.id('cb')) = 46 and rls_test.on_hand(rls_test.id('rm')) = 7
  and rls_test.on_hand(rls_test.id('osc')) = 0,
  format('ca %s cb %s rm %s osc %s', rls_test.on_hand(rls_test.id('ca')), rls_test.on_hand(rls_test.id('cb')), rls_test.on_hand(rls_test.id('rm')), rls_test.on_hand(rls_test.id('osc'))));
select rls_test.ok('finished goods: accepted 96 added to stock; the 4 rejected are recorded only (not stock)',
  rls_test.on_hand(rls_test.id('fg')) = 96 and (rls_test.get('c1') ->> 'accepted')::numeric = 96 and (rls_test.get('c1') ->> 'rejected')::numeric = 4
  and (rls_test.ord(rls_test.gid('o1', 'order_id'))).completed_quantity = 96 and (rls_test.ord(rls_test.gid('o1', 'order_id'))).rejected_quantity = 4);
select rls_test.ok('complete: order COMPLETED, unused reservations released, other orders'' reservations untouched (order 2 still A 50, B 46)',
  (rls_test.ord(rls_test.gid('o1', 'order_id'))).status = 'COMPLETED' and rls_test.res(rls_test.gid('o1', 'order_id'), rls_test.id('ca')) = 0
  and rls_test.res(rls_test.gid('o1', 'order_id'), rls_test.id('rm')) = 0 and rls_test.res(rls_test.gid('o2', 'order_id'), rls_test.id('ca')) = 50
  and rls_test.res(rls_test.gid('o2', 'order_id'), rls_test.id('cb')) = 46);
select rls_test.ok('complete: material variance reported (raw 53 KG used vs 55 standard)',
  (rls_test.get('c1') -> 'warnings')::text ilike '%PD-RM: consumed 53 KG, less than the standard 55%', rls_test.get('c1')::text);
select rls_test.ok('cost: finished goods valued at actual material cost (1000 + 1020 + 1060 + 3000) / 96 = 63.3333',
  (rls_test.get('c1') ->> 'unit_cost')::numeric = 63.3333, rls_test.get('c1') ->> 'unit_cost');
select rls_test.ok('history: production recorded with its ledger entries and links to the order and BOM version',
  'PRODUCTION_RECORDED' = any(rls_test.events(rls_test.gid('o1', 'order_id'))) and jsonb_array_length(rls_test.get('c1') -> 'transaction_numbers') >= 6
  and rls_test.consumption(rls_test.gid('o1', 'order_id'), 'POSTED') >= 4 and (rls_test.ord(rls_test.gid('o1', 'order_id'))).bom_version = 1);
select rls_test.set('tx1', to_jsonb(rls_test.tx_count(rls_test.id('company_a'))));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('no double deduction: the same request again returns the first result', 'c1dup',
  rls_test.complete(rls_test.gid('o1', 'order_id'), jsonb_build_object('actual_quantity', 100), (rls_test.get('ck') #>> '{}')::uuid));
select rls_test.expect_call_error('no double deduction: completing a completed order again is refused',
  rls_test.complete(rls_test.gid('o1', 'order_id'), jsonb_build_object('actual_quantity', 100)), 'completed production order cannot be completed');
select rls_test.expect_call_error('edit: a completed order cannot be edited (use Correct production)',
  rls_test.save(rls_test.gid('o1', 'order_id'), jsonb_build_object('planned_quantity', 90)), 'Correct production');
reset role;
select rls_test.ok('no double deduction: stock and ledger unchanged by the repeats',
  (rls_test.get('c1dup') ->> 'duplicate')::boolean and rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx1'))::bigint
  and rls_test.on_hand(rls_test.id('fg')) = 96 and rls_test.on_hand(rls_test.id('ca')) = 50);

-- ---------------------------------------------------------------------------
-- 4. Corrections by reversal and re-posting
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('setup: BOM of a kit that uses 1 PD-FG', 'bom3',
  format('select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, %L)', rls_test.id('fg3'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('fg'), 'quantity_required', 1)), gen_random_uuid()));
select rls_test.expect_call_ok('setup: activate it', 'bom3_act', format('select public.production_bom_activate(%L, null)', rls_test.gid('bom3', 'bom_id')));
select rls_test.expect_call_ok('setup: create and complete 10 kits in one step (uses 10 of the 96 PD-FG)', 'o3',
  rls_test.save(null, jsonb_build_object('product_id', rls_test.id('fg3'), 'planned_quantity', 10, 'complete', true, 'actual_quantity', 10)));
reset role;
select rls_test.ok('one-step record: kit order created and completed; PD-FG 96 -> 86, kits 10',
  rls_test.get('o3') ->> 'status' = 'COMPLETED' and rls_test.on_hand(rls_test.id('fg')) = 86 and rls_test.on_hand(rls_test.id('fg3')) = 10, rls_test.get('o3')::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('correct: refused when the finished goods have been used (only 86 of 96 left)',
  rls_test.correct(rls_test.gid('o1', 'order_id'), 'Recount of output', jsonb_build_object('actual_quantity', 100)), 'can no longer be taken back');
reset role;
select rls_test.ok('correct: the refused correction changed nothing', rls_test.on_hand(rls_test.id('fg')) = 86
  and (rls_test.ord(rls_test.gid('o1', 'order_id'))).status = 'COMPLETED' and rls_test.outputs(rls_test.gid('o1', 'order_id'), 'POSTED') = 1);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('undo: kit production reversed and the order reopened', 'u3',
  rls_test.correct(rls_test.gid('o3', 'order_id'), 'Kits not assembled yet', null));
select rls_test.expect_call_ok('cancel: the reopened kit order is cancelled (reservations released)', 'x3',
  format('select public.production_order_action(%L, %L, %L)', rls_test.gid('o3', 'order_id'), 'CANCEL', 'Kits not needed'));
reset role;
select rls_test.ok('undo: PD-FG back to 96, kits 0, kit order reopened then cancelled with nothing reserved',
  rls_test.on_hand(rls_test.id('fg')) = 96 and rls_test.on_hand(rls_test.id('fg3')) = 0 and rls_test.get('u3') ->> 'status' in ('APPROVED', 'MATERIALS_RESERVED')
  and (rls_test.ord(rls_test.gid('o3', 'order_id'))).status = 'CANCELLED' and rls_test.res(rls_test.gid('o3', 'order_id'), rls_test.id('fg')) = 0);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('correct: an invalid correction (rejected more than produced) is refused',
  rls_test.correct(rls_test.gid('o1', 'order_id'), 'Wrong figures entered', jsonb_build_object('actual_quantity', 3, 'rejected_quantity', 5)), 'cannot be more than');
reset role;
select rls_test.ok('correct: all or nothing — after the failed correction the original posting is intact (PD-FG 96, raw 7, receipt posted)',
  rls_test.on_hand(rls_test.id('fg')) = 96 and rls_test.on_hand(rls_test.id('rm')) = 7 and rls_test.outputs(rls_test.gid('o1', 'order_id'), 'POSTED') = 1
  and rls_test.outputs(rls_test.gid('o1', 'order_id'), 'REVERSED') = 0);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('correct: order 1 was really 100 good, 0 rejected, 55 KG raw material', 'k1',
  rls_test.correct(rls_test.gid('o1', 'order_id'), 'Rejected units were reworked',
    jsonb_build_object('actual_quantity', 100, 'rejected_quantity', 0, 'materials',
      jsonb_build_array(jsonb_build_object('order_material_id', rls_test.mat(rls_test.gid('o1', 'order_id'), rls_test.id('rm')), 'quantity', 55)))));
reset role;
select rls_test.ok('correct: stock reflects the corrected production — PD-FG 100, raw 60 - 55 = 5 KG, A 50, B 46',
  rls_test.on_hand(rls_test.id('fg')) = 100 and rls_test.on_hand(rls_test.id('rm')) = 5 and rls_test.on_hand(rls_test.id('ca')) = 50
  and rls_test.on_hand(rls_test.id('cb')) = 46,
  format('fg %s rm %s ca %s cb %s', rls_test.on_hand(rls_test.id('fg')), rls_test.on_hand(rls_test.id('rm')), rls_test.on_hand(rls_test.id('ca')), rls_test.on_hand(rls_test.id('cb'))));
select rls_test.ok('correct: history kept — original receipt and issues REVERSED (reversal entries), new ones POSTED; order shows 100 / 0',
  rls_test.outputs(rls_test.gid('o1', 'order_id'), 'REVERSED') = 1 and rls_test.outputs(rls_test.gid('o1', 'order_id'), 'POSTED') = 1
  and rls_test.consumption(rls_test.gid('o1', 'order_id'), 'REVERSED') >= 4 and jsonb_array_length(rls_test.get('k1') -> 'reversal_numbers') >= 5
  and (rls_test.ord(rls_test.gid('o1', 'order_id'))).completed_quantity = 100 and (rls_test.ord(rls_test.gid('o1', 'order_id'))).rejected_quantity = 0
  and 'PRODUCTION_REVERSED' = any(rls_test.events(rls_test.gid('o1', 'order_id'))) and 'PRODUCTION_CORRECTED' = any(rls_test.events(rls_test.gid('o1', 'order_id'))));
select rls_test.ok('ledger: balances and reservations equal the ledger after postings and reversals', rls_test.ledger_consistent(rls_test.id('company_a')));

set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('undo: order 1 reopened (production reversed, materials reserved again)', 'u1',
  rls_test.correct(rls_test.gid('o1', 'order_id'), 'Batch to be produced again', null));
reset role;
select rls_test.ok('undo: PD-FG 0, raw back to 60 KG, order open with A 100 and raw 55 KG reserved again',
  rls_test.on_hand(rls_test.id('fg')) = 0 and rls_test.on_hand(rls_test.id('rm')) = 60 and rls_test.get('u1') ->> 'status' in ('APPROVED', 'MATERIALS_RESERVED')
  and rls_test.res(rls_test.gid('o1', 'order_id'), rls_test.id('ca')) = 100 and rls_test.res(rls_test.gid('o1', 'order_id'), rls_test.id('rm')) = 55
  and 'REOPENED' = any(rls_test.events(rls_test.gid('o1', 'order_id'))), rls_test.get('u1')::text);

-- ---------------------------------------------------------------------------
-- 5. Edit an open order: quantity, date, remarks; recalculated and re-reserved
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('edit: order 2 changed to 20 units, tomorrow, new remarks', 'o2e',
  rls_test.save(rls_test.gid('o2', 'order_id'), jsonb_build_object('planned_quantity', 20, 'production_date', rls_test.today() + 1, 'remarks', 'Smaller batch')));
select rls_test.expect_call_error('cancel: a cancelled order cannot be edited',
  rls_test.save(rls_test.gid('o3', 'order_id'), jsonb_build_object('planned_quantity', 5)), 'cannot be edited');
reset role;
select rls_test.ok('edit: plan recalculated (A 20, B 41, raw 11 KG) and reservations replaced, not added (A 20 reserved)',
  rls_test.planned(rls_test.gid('o2', 'order_id'), rls_test.id('ca')) = 20 and rls_test.planned(rls_test.gid('o2', 'order_id'), rls_test.id('cb')) = 41
  and rls_test.planned(rls_test.gid('o2', 'order_id'), rls_test.id('rm')) = 11 and rls_test.res(rls_test.gid('o2', 'order_id'), rls_test.id('ca')) = 20
  and (rls_test.ord(rls_test.gid('o2', 'order_id'))).planned_start_date = rls_test.today() + 1
  and (rls_test.ord(rls_test.gid('o2', 'order_id'))).notes = 'Smaller batch' and 'UPDATED' = any(rls_test.events(rls_test.gid('o2', 'order_id'))));

-- ---------------------------------------------------------------------------
-- 6. Add missing components from the production screen
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('components: PD-FG2 had no BOM — add Component A, 2 per unit (BOM v1 created and active)', 'ac2',
  format('select public.production_bom_add_components(%L, %L::jsonb, %L)', rls_test.id('fg2'),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('ca'), 'quantity_per_unit', 2)), gen_random_uuid()));
select rls_test.expect_call_ok('components: preview of PD-FG2 now uses it', 'pv2b', format('select public.production_v2_preview(%L, 5, null)', rls_test.id('fg2')));
select rls_test.expect_call_ok('components: packing carton added to PD-FG (new version, old kept)', 'ac1',
  format('select public.production_bom_add_components(%L, %L::jsonb, %L)', rls_test.id('fg'),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('extra'), 'quantity_per_unit', 1)), gen_random_uuid()));
select rls_test.expect_call_error('components: a component already in the BOM is refused',
  format('select public.production_bom_add_components(%L, %L::jsonb, %L)', rls_test.id('fg'),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('ca'), 'quantity_per_unit', 1)), gen_random_uuid()), 'already in');
-- 20261118: an edited order keeps its BOM version unless the user explicitly chooses the latest.
select rls_test.expect_call_ok('recalculate: order 1 saved again with "use the latest versions" picks up BOM v2', 'o1r', rls_test.save(rls_test.gid('o1', 'order_id'), '{"use_latest_versions": true}'::jsonb));
reset role;
select rls_test.ok('components: PD-FG2 BOM v1 active with A = 2 per unit -> 10 for 5 units',
  (rls_test.get('ac2') ->> 'version')::int = 1 and (rls_test.get('pv2b') -> 'bom' ->> 'version')::int = 1
  and (rls_test.line(rls_test.get('pv2b'), 'PD-CA') ->> 'required')::numeric = 10, rls_test.get('pv2b')::text);
select rls_test.ok('components: PD-FG BOM v2 has 5 components; v1 is kept (no longer in force)',
  (rls_test.get('ac1') ->> 'version')::int = 2 and (rls_test.get('ac1') ->> 'components')::int = 5
  and exists (select 1 from public.boms where finished_product_id = rls_test.id('fg') and version = 1));
select rls_test.ok('recalculate: order 1 now on BOM v2 with 5 material lines; carton short by 80 (20 reserved)',
  (rls_test.ord(rls_test.gid('o1', 'order_id'))).bom_version = 2 and jsonb_array_length(rls_test.get('o1r') -> 'requirements') = 5
  and rls_test.res(rls_test.gid('o1', 'order_id'), rls_test.id('extra')) = 20 and (rls_test.get('o1r') -> 'warnings')::text ilike '%PD-EXTRA: short by 80 PCS%',
  rls_test.get('o1r')::text);

-- ---------------------------------------------------------------------------
-- 7. Excel upload: preview, valid rows imported, every invalid row reported
-- ---------------------------------------------------------------------------
select rls_test.set('rows', jsonb_build_array(
  jsonb_build_object('row_number', 2, 'production_date', rls_test.today()::text, 'sku', 'pd-fg', 'planned_quantity', '10', 'actual_quantity', '', 'rejected_quantity', '', 'remarks', 'Night shift'),
  jsonb_build_object('row_number', 3, 'production_date', rls_test.today()::text, 'sku', 'NOPE-1', 'planned_quantity', '5'),
  jsonb_build_object('row_number', 4, 'production_date', rls_test.today()::text, 'sku', 'PD-FG2', 'planned_quantity', '5', 'actual_quantity', '5', 'rejected_quantity', '1'),
  jsonb_build_object('row_number', 5, 'production_date', '31/12/2026', 'sku', 'PD-FG', 'planned_quantity', '5'),
  jsonb_build_object('row_number', 6, 'production_date', rls_test.today()::text, 'sku', 'PD-FG', 'planned_quantity', '5', 'actual_quantity', '3', 'rejected_quantity', '4'),
  jsonb_build_object('row_number', 7, 'production_date', rls_test.today()::text, 'sku', 'PD-FG', 'planned_quantity', '1.5'),
  jsonb_build_object('row_number', 8, 'production_date', rls_test.today()::text, 'sku', 'PD-FG', 'planned_quantity', '10')));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('import: preview of 7 rows', 'ip', format('select public.production_import_preview(%L::jsonb, null)', rls_test.get('rows')));
reset role;
select rls_test.ok('import: SKUs matched case-insensitively, BOM fetched, requirements and availability calculated per row',
  (select r ->> 'sku' = 'PD-FG' and (r ->> 'bom_version')::int = 2 and jsonb_array_length(r -> 'materials') = 5
   from jsonb_array_elements(rls_test.get('ip') -> 'rows') r where (r ->> 'row_number')::int = 2), rls_test.get('ip')::text);
select rls_test.ok('import: errors — unknown SKU, bad date, rejected > actual, half a piece; each with its message',
  (select bool_and(r ->> 'status' = 'ERROR') from jsonb_array_elements(rls_test.get('ip') -> 'rows') r where (r ->> 'row_number')::int in (3, 5, 6, 7))
  and (rls_test.get('ip') -> 'rows')::text ilike '%NOPE-1%was not found in the Product Master%' and (rls_test.get('ip') -> 'rows')::text ilike '%is not a valid date%'
  and (rls_test.get('ip') -> 'rows')::text ilike '%cannot be more than the Actual Quantity%' and (rls_test.get('ip') -> 'rows')::text ilike '%whole numbers%',
  (select string_agg(format('row %s %s %s', r ->> 'row_number', r ->> 'status', r -> 'errors'), ' | ') from jsonb_array_elements(rls_test.get('ip') -> 'rows') r));
select rls_test.ok('import: shortages are warnings on open orders; a repeated row is flagged as a possible duplicate',
  (select r ->> 'status' = 'WARNING' and (r -> 'warnings')::text ilike '%short by%' from jsonb_array_elements(rls_test.get('ip') -> 'rows') r where (r ->> 'row_number')::int = 2)
  and (select (r -> 'warnings')::text ilike '%as row 2%' from jsonb_array_elements(rls_test.get('ip') -> 'rows') r where (r ->> 'row_number')::int = 8)
  and (rls_test.get('ip') ->> 'errors')::int = 4);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('import: valid rows imported', 'im',
  format('select public.production_import(%L::jsonb, null, %L::jsonb, %L)', rls_test.get('rows'),
    jsonb_build_object('file_name', 'production.xlsx', 'total_rows', 7), gen_random_uuid()));
reset role;
select rls_test.ok('import: 3 rows created, 4 reported as failed with their messages (none skipped silently)',
  (rls_test.get('im') ->> 'created_count')::int = 3 and (rls_test.get('im') ->> 'failed_count')::int = 4
  and (select array_agg((f ->> 'row_number')::int order by (f ->> 'row_number')::int) from jsonb_array_elements(rls_test.get('im') -> 'failed') f) = array[3, 5, 6, 7],
  rls_test.get('im')::text);
select rls_test.ok('import: the row with an actual quantity was recorded as completed production — PD-FG2 4 accepted in stock, 1 rejected; A used 10',
  (select c ->> 'status' = 'COMPLETED' from jsonb_array_elements(rls_test.get('im') -> 'created') c where (c ->> 'row_number')::int = 4)
  and rls_test.on_hand(rls_test.id('fg2')) = 4 and rls_test.on_hand(rls_test.id('ca')) = 140);
select rls_test.ok('import: recorded in Bulk Operations as a PRODUCTION import with the failed rows',
  exists (select 1 from public.import_jobs where id = rls_test.gid('im', 'job_id') and import_type = 'PRODUCTION' and success_rows = 3 and failed_rows = 4)
  and (select count(*) from public.import_job_rows where job_id = rls_test.gid('im', 'job_id')) = 4);

-- ---------------------------------------------------------------------------
-- 8. Dashboard
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('dashboard: this month', 'db', format('select public.production_dashboard(%L, %L)', rls_test.today() - 30, rls_test.today()));
reset role;
select rls_test.ok('dashboard: finished goods produced in range = 4 PCS (order 1 and the kits were reversed); 1 rejected',
  (rls_test.get('db') -> 'finished_goods')::text = '[{"unit": "PCS", "quantity": 4.000}]' and (rls_test.get('db') -> 'rejected')::text = '[{"unit": "PCS", "quantity": 1.000}]',
  rls_test.get('db')::text);
select rls_test.ok('dashboard: raw materials consumed nets out reversals (0 KG posted); components consumed 10 PCS',
  (rls_test.get('db') -> 'raw_materials') = '[]'::jsonb and (rls_test.get('db') -> 'components')::text = '[{"unit": "PCS", "quantity": 10.000}]',
  (rls_test.get('db') -> 'raw_materials')::text || ' ' || (rls_test.get('db') -> 'components')::text);
select rls_test.ok('dashboard: open orders, pending quantity, shortages by component and recent activity',
  (rls_test.get('db') ->> 'open_orders')::int = 4 and (rls_test.get('db') ->> 'orders')::int >= 4
  and exists (select 1 from jsonb_array_elements(rls_test.get('db') -> 'shortages') s where s ->> 'sku' = 'PD-EXTRA')
  and jsonb_array_length(rls_test.get('db') -> 'recent') > 0 and jsonb_array_length(rls_test.get('db') -> 'pending') = 1, rls_test.get('db')::text);
select rls_test.ok('ledger: still consistent at the end', rls_test.ledger_consistent(rls_test.id('company_a')));

-- ---------------------------------------------------------------------------
-- 9. Isolation and grants
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('b_op');
select rls_test.expect_call_error('isolation: company B cannot complete company A''s order',
  rls_test.complete(rls_test.gid('o2', 'order_id'), jsonb_build_object('actual_quantity', 1)), 'not found');
select rls_test.expect_call_error('isolation: company B cannot preview company A''s product',
  format('select public.production_v2_preview(%L, 1, null)', rls_test.id('fg')), 'not found');
select rls_test.expect_call_ok('isolation: company B dashboard', 'dbb', format('select public.production_dashboard(%L, %L)', rls_test.today() - 30, rls_test.today()));
reset role;
select rls_test.ok('isolation: company B sees no orders or activity', (rls_test.get('dbb') ->> 'orders')::int = 0 and jsonb_array_length(rls_test.get('dbb') -> 'recent') = 0);
select rls_test.ok('grants: anon cannot call the production functions',
  not has_function_privilege('anon', 'public.production_order_v2_save(uuid, jsonb, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.production_order_v2_complete(uuid, jsonb, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.production_order_v2_correct(uuid, text, jsonb, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.production_import(jsonb, uuid, jsonb, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.production_dashboard(date, date)', 'EXECUTE'));

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
  raise exception 'PRODUCTION_V2_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
