-- =============================================================================
-- IMMUTABLE PRODUCT, COMPONENT AND BOM VERSIONS (ALTON ERP V2)
-- migration 20261118090000_master_versioning.sql
--
-- Numbers = section 11 of the request. The reports are captured before and after
-- master-data changes; every historical row must be identical.
-- Runs in one transaction and ALWAYS ends by raising
--   MASTER_VERSIONING_RESULT passed=N failed=M
-- =============================================================================

begin;

create schema rls_test;
grant usage on schema rls_test to anon, authenticated, service_role;
create table rls_test.results (id serial primary key, name text not null, passed boolean not null, detail text);
create table rls_test.ids (key text primary key, id uuid not null);
create table rls_test.vars (key text primary key, value jsonb);
grant select, insert on rls_test.results to anon, authenticated, service_role;
grant usage on sequence rls_test.results_id_seq to anon, authenticated, service_role;
grant select on rls_test.ids to anon, authenticated, service_role;
grant select, insert, update on rls_test.vars to anon, authenticated, service_role;

create function rls_test.id(p_key text) returns uuid language sql stable as $$ select id from rls_test.ids where key = p_key $$;
create function rls_test.ok(p_name text, p_cond boolean, p_detail text default null) returns void language plpgsql as $$
begin insert into rls_test.results (name, passed, detail) values (p_name, coalesce(p_cond, false), p_detail); end $$;
create function rls_test.call(p_sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin execute p_sql into r; return coalesce(r, 'null'::jsonb);
exception when others then return jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate); end $$;
create function rls_test.set(p_key text, p_value jsonb) returns jsonb language plpgsql as $$
begin insert into rls_test.vars values (p_key, p_value) on conflict (key) do update set value = excluded.value; return p_value; end $$;
create function rls_test.get(p_key text) returns jsonb language sql stable as $$ select value from rls_test.vars where key = p_key $$;
create function rls_test.gid(p_key text, p_field text) returns uuid language sql stable as $$ select (value ->> p_field)::uuid from rls_test.vars where key = p_key $$;
create function rls_test.expect_call_ok(p_name text, p_key text, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.set(p_key, r); perform rls_test.ok(p_name, not (jsonb_typeof(r) = 'object' and r ? 'sqlstate'), r::text); return r; end $$;
create function rls_test.expect_call_error(p_name text, p_sql text, p_pattern text default null) returns void language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.ok(p_name, jsonb_typeof(r) = 'object' and r ? 'sqlstate' and (p_pattern is null or r ->> 'error' ilike '%' || p_pattern || '%' or r ->> 'sqlstate' = p_pattern), r::text); end $$;
create function rls_test.claims(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', rls_test.id(p_key), 'role', 'authenticated')::text, true) $$;
create function rls_test.role_id(p_code text) returns uuid language sql stable security definer as $$ select id from public.roles where code = p_code $$;
create function rls_test.today() returns date language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;
create function rls_test.grn(p_product uuid, p_qty numeric, p_cost numeric) returns text language sql stable as $$
  select format('select public.goods_receipt_direct_post(%L::jsonb, %L::jsonb, %L)',
    jsonb_build_object('warehouse_id', rls_test.id('w1')),
    jsonb_build_array(jsonb_build_object('product_id', p_product, 'received_quantity', p_qty, 'accepted_quantity', p_qty, 'unit_cost', p_cost,
      'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()) $$;
create function rls_test.save_bom(p_bom uuid, p_items jsonb, p_from date default null) returns text language sql stable as $$
  select format('select public.production_save_bom(%L, %L, %L, null, 1, null, %L::jsonb, %L)', p_bom, rls_test.id('fg'), coalesce(p_from, rls_test.today()), p_items, gen_random_uuid()) $$;
create function rls_test.order_save(p_order uuid, p_data jsonb) returns text language sql stable as $$
  select format('select public.production_order_v2_save(%L, %L::jsonb, %L)', p_order, p_data, gen_random_uuid()) $$;
create function rls_test.report(p_report text) returns text language sql stable as $$
  select format('select public.erp_report_v2(%L, %L::jsonb)', p_report, jsonb_build_object('from', rls_test.today() - 1, 'to', rls_test.today() + 1)) $$;
create function rls_test.preport(p_report text) returns text language sql stable as $$
  select format('select coalesce(jsonb_agg(r), ''[]''::jsonb) from public.production_report(%L, %L, %L) r', p_report, rls_test.today() - 1, rls_test.today() + 1) $$;
-- Owner-side probes
create function rls_test.versions(p_product uuid) returns setof public.product_versions language sql stable security definer as $$
  select * from public.product_versions where product_id = p_product order by version_no $$;
create function rls_test.version_count(p_product uuid) returns bigint language sql stable security definer as $$ select count(*) from public.product_versions where product_id = p_product $$;
create function rls_test.cur(p_product uuid) returns public.product_versions language sql stable security definer as $$ select * from public.product_versions where product_id = p_product and is_current $$;
create function rls_test.bom(p_id uuid) returns public.boms language sql stable security definer as $$ select * from public.boms where id = p_id $$;
create function rls_test.bom_items(p_bom uuid) returns jsonb language sql stable security definer as $$
  select coalesce(jsonb_agg(jsonb_build_object('c', component_product_id, 'q', quantity_required, 'u', unit, 'w', wastage_percentage, 'v', component_version_id) order by line_no), '[]')
  from public.bom_items where bom_id = p_bom $$;
create function rls_test.ord(p_id uuid) returns public.production_orders language sql stable security definer as $$ select * from public.production_orders where id = p_id $$;
create function rls_test.mats(p_order uuid) returns jsonb language sql stable security definer as $$
  select coalesce(jsonb_agg(jsonb_build_object('c', component_product_id, 'per', quantity_per_unit, 'planned', planned_quantity, 'sku', component_sku_snapshot,
    'name', component_name_snapshot, 'cost', standard_cost_snapshot, 'v', component_version_id) order by line_no), '[]')
  from public.production_order_materials where production_order_id = p_order $$;
create function rls_test.ledger(p_company uuid) returns jsonb language sql stable security definer as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.transaction_number), '[]') from public.inventory_transactions t where t.company_id = p_company $$;
create function rls_test.rows_for(p_report jsonb, p_key text, p_value text) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(r order by r::text), '[]') from jsonb_array_elements(coalesce(p_report -> 'rows', p_report)) r where r ->> p_key = p_value $$;
create function rls_test.revisions(p_order uuid) returns text[] language sql stable security definer as $$
  select coalesce(array_agg(kind order by changed_at, kind), '{}') from public.production_order_revisions where production_order_id = p_order $$;
grant execute on all functions in schema rls_test to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5d300-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5d300-0000-4000-8000-0000000000b1'),
  ('op', 'e7e5d300-0000-4000-8000-000000000001'), ('viewer', 'e7e5d300-0000-4000-8000-000000000002'), ('b_op', 'e7e5d300-0000-4000-8000-000000000003'),
  ('fg', 'e7e5d300-0000-4000-8000-0000000000d1'), ('ca', 'e7e5d300-0000-4000-8000-0000000000d2'), ('cb', 'e7e5d300-0000-4000-8000-0000000000d3'),
  ('cnew', 'e7e5d300-0000-4000-8000-0000000000d4'), ('legacy', 'e7e5d300-0000-4000-8000-0000000000d5'),
  ('w1', 'e7e5d300-0000-4000-8000-0000000000e1');
insert into public.companies (id, legal_name, display_name, company_code, gstin, legal_address) values
  (rls_test.id('company_a'), 'Versioning A Pvt Ltd', 'Versioning A', 'MVA', '27AAACP1234A1Z5', 'Pune'),
  (rls_test.id('company_b'), 'Versioning B Pvt Ltd', 'Versioning B', 'MVB', null, null);
insert into auth.users (id, email) select id, key || '@mv.example.invalid' from rls_test.ids where key in ('op', 'viewer', 'b_op');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true, full_name = 'Vera Operator' where id = rls_test.id('op');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = rls_test.id('viewer');
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_op');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('op'), rls_test.id('company_a'), rls_test.role_id('SUPER_ADMIN')),
  (rls_test.id('viewer'), rls_test.id('company_a'), rls_test.role_id('MANAGEMENT_VIEWER')),
  (rls_test.id('b_op'), rls_test.id('company_b'), rls_test.role_id('SUPER_ADMIN'));
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, track_batches, track_expiry, status, standard_cost, hsn_code, gst_rate) values
  (rls_test.id('fg'), rls_test.id('company_a'), 'MV-FG', 'Basin set', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, 'ACTIVE', null, '6910', 18),
  (rls_test.id('ca'), rls_test.id('company_a'), 'MV-CA', 'Ceramic bowl', 'COMPONENT', 'IN_HOUSE', 'PCS', false, false, 'ACTIVE', 10, '6910', 18),
  (rls_test.id('cb'), rls_test.id('company_a'), 'MV-CB', 'Brass tap', 'COMPONENT', 'IN_HOUSE', 'PCS', false, false, 'ACTIVE', 5, '8481', 18);
insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Factory', true);
insert into rls_test.ids (key, id) select 'g1', id from public.inventory_locations where location_code = 'GENERAL' and warehouse_id = rls_test.id('w1');

-- A legacy product (existed before version control): created without the version trigger, then the
-- migration's baseline step runs; and a legacy stock entry (posted before snapshots existed).
alter table public.products disable trigger products_version_created;
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, track_batches, track_expiry, status, standard_cost) values
  (rls_test.id('legacy'), rls_test.id('company_a'), 'MV-OLD', 'Old washer', 'RAW_MATERIAL', 'OUTSOURCED', 'PCS', false, false, 'ACTIVE', 2);
alter table public.products enable trigger products_version_created;
insert into public.product_versions (company_id, product_id, version_no, effective_from, is_current, is_legacy, source, sku, product_name,
  description, product_type, base_unit, hsn_code, gst_rate, standard_cost, selling_price, mrp, attributes, change_reason, created_by)
select p.company_id, p.id, 1, p.created_at, true, true, 'LEGACY_BASELINE', p.sku, p.product_name, p.description, p.product_type, p.base_unit,
  p.hsn_code, p.gst_rate, p.standard_cost, p.selling_price, p.mrp, private.product_version_attrs(p),
  'Legacy baseline: the values when version control was introduced. Earlier changes were not recorded.', p.created_by
from public.products p where p.id = rls_test.id('legacy');
alter table public.inventory_transactions disable trigger inventory_transactions_a_snapshot;
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('setup: legacy receipt of 50 MV-OLD (no snapshot, as before the migration)', 'g_old', rls_test.grn(rls_test.id('legacy'), 50, 2));
reset role;
alter table public.inventory_transactions enable trigger inventory_transactions_a_snapshot;

select rls_test.ok('versions: new products get version 1 (created), current, with their values',
  (rls_test.cur(rls_test.id('ca'))).version_no = 1 and (rls_test.cur(rls_test.id('ca'))).source = 'CREATED'
  and (rls_test.cur(rls_test.id('ca'))).product_name = 'Ceramic bowl' and (rls_test.cur(rls_test.id('ca'))).standard_cost = 10
  and (rls_test.cur(rls_test.id('ca'))).hsn_code = '6910' and (rls_test.cur(rls_test.id('ca'))).base_unit = 'PCS');
select rls_test.ok('12. legacy product: baseline version marked legacy, with an honest reason',
  (rls_test.cur(rls_test.id('legacy'))).is_legacy and (rls_test.cur(rls_test.id('legacy'))).source = 'LEGACY_BASELINE'
  and (rls_test.cur(rls_test.id('legacy'))).change_reason like 'Legacy baseline%');

-- Stock, BOM v1, production order 1 (completed) — all before any master change.
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('setup: receive 100 MV-CA @10', 'g_ca', rls_test.grn(rls_test.id('ca'), 100, 10));
select rls_test.expect_call_ok('setup: receive 200 MV-CB @5', 'g_cb', rls_test.grn(rls_test.id('cb'), 200, 5));
select rls_test.expect_call_ok('setup: BOM v1 of MV-FG: 1 bowl, 2 taps', 'bom1',
  rls_test.save_bom(null, jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('ca'), 'quantity_required', 1),
    jsonb_build_object('component_product_id', rls_test.id('cb'), 'quantity_required', 2))));
select rls_test.expect_call_ok('BOM: reason and process instructions on the draft', 'bom1_det',
  format('select public.bom_version_details_save(%L, %L, %L)', rls_test.gid('bom1', 'bom_id'), 'First release', 'Fit tap to bowl, torque 5 Nm'));
select rls_test.expect_call_ok('setup: activate BOM v1', 'bom1_act', format('select public.production_bom_activate(%L, null)', rls_test.gid('bom1', 'bom_id')));
select rls_test.expect_call_ok('setup: production order 1, 10 sets (BOM v1)', 'o1',
  rls_test.order_save(null, jsonb_build_object('product_id', rls_test.id('fg'), 'planned_quantity', 10, 'production_date', rls_test.today())));
select rls_test.expect_call_ok('setup: complete order 1 (10 sets)', 'c1',
  format('select public.production_order_v2_complete(%L, %L::jsonb, %L)', rls_test.gid('o1', 'order_id'),
    jsonb_build_object('actual_quantity', 10, 'production_date', rls_test.today()), gen_random_uuid()));
select rls_test.expect_call_ok('setup: production order 2, 5 sets (BOM v1, released, not completed)', 'o2',
  rls_test.order_save(null, jsonb_build_object('product_id', rls_test.id('fg'), 'planned_quantity', 5, 'production_date', rls_test.today())));
-- Reports and lists before any master change
select rls_test.set('mv_before', rls_test.call(rls_test.report('STOCK_MOVEMENTS')));
select rls_test.set('cons_before', rls_test.call(rls_test.report('MATERIAL_CONSUMPTION')));
select rls_test.set('reg_before', rls_test.call(rls_test.report('PRODUCTION_REGISTER')));
select rls_test.set('grn_before', rls_test.call(rls_test.report('GRN_REGISTER')));
select rls_test.set('cost_before', rls_test.call(rls_test.preport('COST_SUMMARY')));
select rls_test.set('pvac_before', rls_test.call(rls_test.preport('PLANNED_VS_ACTUAL_CONSUMPTION')));
select rls_test.set('sum_before', rls_test.call(rls_test.preport('ORDERS_SUMMARY')));
select rls_test.set('list_before', rls_test.call('select coalesce(jsonb_agg(jsonb_build_object(''n'', transaction_number, ''sku'', sku, ''name'', product_name) order by transaction_number), ''[]'') from public.inventory_transaction_list'));
select rls_test.set('olist_before', rls_test.call('select coalesce(jsonb_agg(jsonb_build_object(''n'', production_order_number, ''sku'', sku, ''name'', product_name) order by production_order_number), ''[]'') from public.production_order_list'));
reset role;
select rls_test.set('ledger_before', rls_test.ledger(rls_test.id('company_a')));
select rls_test.set('bom1_items', rls_test.bom_items(rls_test.gid('bom1', 'bom_id')));
select rls_test.set('o1_mats', rls_test.mats(rls_test.gid('o1', 'order_id')));
select rls_test.set('o2_mats', rls_test.mats(rls_test.gid('o2', 'order_id')));

select rls_test.ok('snapshots: new stock entries record product version, code and name; production orders and plans record versions, names and standard cost',
  not exists (select 1 from jsonb_array_elements(rls_test.get('ledger_before')) t
              where t ->> 'product_id' <> rls_test.id('legacy')::text and (t ->> 'product_version_id' is null or t ->> 'sku_snapshot' is null))
  and (rls_test.ord(rls_test.gid('o1', 'order_id'))).product_version_id = (rls_test.cur(rls_test.id('fg'))).id
  and (rls_test.ord(rls_test.gid('o1', 'order_id'))).product_name_snapshot = 'Basin set'
  and rls_test.get('o1_mats') -> 0 ->> 'name' = 'Ceramic bowl' and (rls_test.get('o1_mats') -> 0 ->> 'cost')::numeric = 10
  and (rls_test.get('o1_mats') -> 1 ->> 'cost')::numeric = 5, rls_test.get('o1_mats')::text);
select rls_test.ok('BOM: approved v1 records the component versions it was approved with, its reason and instructions',
  rls_test.get('bom1_items') -> 0 ->> 'v' = (rls_test.cur(rls_test.id('ca'))).id::text and rls_test.get('bom1_items') -> 1 ->> 'v' = (rls_test.cur(rls_test.id('cb'))).id::text
  and (rls_test.bom(rls_test.gid('bom1', 'bom_id'))).change_reason = 'First release'
  and (rls_test.bom(rls_test.gid('bom1', 'bom_id'))).process_instructions = 'Fit tap to bowl, torque 5 Nm');
select rls_test.ok('setup: the reports have rows for the orders and movements', jsonb_array_length(rls_test.get('mv_before') -> 'rows') >= 5
  and jsonb_array_length(rls_test.get('cons_before') -> 'rows') = 2 and jsonb_array_length(rls_test.get('cost_before')) >= 1, rls_test.get('cost_before')::text);

-- ---------------------------------------------------------------------------
-- Master changes: product edits (name, cost, HSN), a new component, BOM v2
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('1. edit the component: new name, standard cost 10 -> 12, HSN, with a reason', 'e_ca',
  format('update public.products set product_name = %L, standard_cost = 12, hsn_code = %L, change_reason = %L where id = %L returning jsonb_build_object(''id'', id)',
    'Ceramic bowl (new glaze)', '6911', 'Supplier changed the glaze', rls_test.id('ca')));
select rls_test.expect_call_ok('1. edit the other component and the finished product without a reason', 'e_cb',
  format('update public.products set product_name = %L, standard_cost = 6 where id = %L returning jsonb_build_object(''id'', id)', 'Brass tap (chrome)', rls_test.id('cb')));
select rls_test.expect_call_ok('1. rename the finished product', 'e_fg',
  format('update public.products set product_name = %L where id = %L returning jsonb_build_object(''id'', id)', 'Basin set Deluxe', rls_test.id('fg')));
select rls_test.expect_call_ok('12. rename the legacy product', 'e_old',
  format('update public.products set product_name = %L where id = %L returning jsonb_build_object(''id'', id)', 'Washer (EPDM)', rls_test.id('legacy')));
select rls_test.expect_call_ok('an edit that changes nothing', 'e_same',
  format('update public.products set product_name = product_name where id = %L returning jsonb_build_object(''id'', id)', rls_test.id('cb')));
select rls_test.expect_call_ok('history: product version history with changes and reason', 'hist_ca', format('select public.product_version_history(%L)', rls_test.id('ca')));
reset role;
-- 2. A new component is added to the Product Master.
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, track_batches, track_expiry, status, standard_cost)
values (rls_test.id('cnew'), rls_test.id('company_a'), 'MV-CN', 'Drain plug', 'COMPONENT', 'IN_HOUSE', 'PCS', false, false, 'ACTIVE', 3);
select rls_test.ok('1. product edit: version 1 closed (effective_to set), version 2 current with previous -> new values and the reason',
  rls_test.version_count(rls_test.id('ca')) = 2 and (select effective_to is not null and not is_current from rls_test.versions(rls_test.id('ca')) where version_no = 1)
  and (rls_test.cur(rls_test.id('ca'))).version_no = 2 and (rls_test.cur(rls_test.id('ca'))).change_reason = 'Supplier changed the glaze'
  and (rls_test.cur(rls_test.id('ca'))).changes -> 'product_name' ->> 'from' = 'Ceramic bowl'
  and (rls_test.cur(rls_test.id('ca'))).changes -> 'product_name' ->> 'to' = 'Ceramic bowl (new glaze)'
  and ((rls_test.cur(rls_test.id('ca'))).changes -> 'standard_cost' ->> 'from')::numeric = 10 and (rls_test.cur(rls_test.id('ca'))).changes ? 'hsn_code'
  and not ((rls_test.cur(rls_test.id('ca'))).changes ? 'updated_at'), (rls_test.cur(rls_test.id('ca'))).changes::text);
select rls_test.ok('1. product identity kept: same id and code; a reason-less edit is recorded as "Not stated"; an edit that changes nothing adds no version',
  (select sku from public.products where id = rls_test.id('ca')) = 'MV-CA' and (rls_test.cur(rls_test.id('cb'))).change_reason = 'Not stated'
  and rls_test.version_count(rls_test.id('cb')) = 2 and (select change_reason from public.products where id = rls_test.id('ca')) is null);
select rls_test.ok('history: versions newest first with who, when, reason, changes and values',
  jsonb_array_length(rls_test.get('hist_ca') -> 'versions') = 2 and (rls_test.get('hist_ca') -> 'versions' -> 0 ->> 'version_no')::int = 2
  and rls_test.get('hist_ca') -> 'versions' -> 0 ->> 'created_by' = 'Vera Operator'
  and rls_test.get('hist_ca') -> 'versions' -> 1 -> 'values' ->> 'product_name' = 'Ceramic bowl', rls_test.get('hist_ca')::text);
select rls_test.ok('2. adding a component does not change the existing BOM', rls_test.bom_items(rls_test.gid('bom1', 'bom_id')) = rls_test.get('bom1_items'));

set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('4. an approved BOM line cannot be edited in place',
  format('update public.bom_items set quantity_required = 3 where bom_id = %L returning jsonb_build_object(''id'', id)', rls_test.gid('bom1', 'bom_id')), 'permission denied');
select rls_test.expect_call_error('4. an approved BOM''s reason cannot be changed', format('select public.bom_version_details_save(%L, ''x'', null)', rls_test.gid('bom1', 'bom_id')), 'Only a draft');
select rls_test.expect_call_ok('3. change quantities and add the new component: a new BOM version', 'bom2',
  format('select public.production_new_bom_version(%L, %L)', rls_test.gid('bom1', 'bom_id'), gen_random_uuid()));
select rls_test.expect_call_ok('3. v2: 3 bowls instead of 1, plus the drain plug', 'bom2_save',
  rls_test.save_bom(rls_test.gid('bom2', 'bom_id'), jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('ca'), 'quantity_required', 3),
    jsonb_build_object('component_product_id', rls_test.id('cb'), 'quantity_required', 2), jsonb_build_object('component_product_id', rls_test.id('cnew'), 'quantity_required', 1))));
select rls_test.expect_call_ok('3. reason for v2', 'bom2_det', format('select public.bom_version_details_save(%L, %L, null)', rls_test.gid('bom2', 'bom_id'), 'Three-bowl design'));
select rls_test.expect_call_ok('3. activate v2', 'bom2_act', format('select public.production_bom_activate(%L, null)', rls_test.gid('bom2', 'bom_id')));
select rls_test.expect_call_ok('5. a new production order after the change', 'o3',
  rls_test.order_save(null, jsonb_build_object('product_id', rls_test.id('fg'), 'planned_quantity', 4, 'production_date', rls_test.today())));
select rls_test.expect_call_ok('history: BOM versions', 'bom_hist', format('select public.bom_version_history(%L)', rls_test.gid('bom1', 'bom_id')));
reset role;
select rls_test.ok('3. editing quantities created version 2; version 1 is untouched (same lines, quantities, component versions)',
  (rls_test.bom(rls_test.gid('bom2', 'bom_id'))).version = 2 and rls_test.bom_items(rls_test.gid('bom1', 'bom_id')) = rls_test.get('bom1_items')
  and jsonb_array_length(rls_test.bom_items(rls_test.gid('bom2', 'bom_id'))) = 3
  and (rls_test.bom_items(rls_test.gid('bom2', 'bom_id')) -> 0 ->> 'q')::numeric = 3
  and rls_test.bom_items(rls_test.gid('bom2', 'bom_id')) -> 0 ->> 'v' = (rls_test.cur(rls_test.id('ca'))).id::text);
select rls_test.ok('3. only one approved version is effective at a time; v1 replaced, v2 active, with lifecycle, reason and line versions',
  (select count(*) from public.boms where finished_product_id = rls_test.id('fg') and status = 'APPROVED') = 1
  and (rls_test.bom(rls_test.gid('bom1', 'bom_id'))).status in ('ARCHIVED', 'APPROVED')
  and rls_test.get('bom_hist') -> 'versions' -> 0 ->> 'lifecycle' = 'ACTIVE' and rls_test.get('bom_hist') -> 'versions' -> 0 ->> 'change_reason' = 'Three-bowl design'
  and rls_test.get('bom_hist') -> 'versions' -> 1 -> 'items' -> 0 ->> 'product_name' = 'Ceramic bowl'
  and rls_test.get('bom_hist') -> 'versions' -> 1 -> 'items' -> 0 ->> 'component_version' = 'v1'
  and rls_test.get('bom_hist') -> 'versions' -> 0 -> 'items' -> 0 ->> 'component_version' = 'v2', rls_test.get('bom_hist')::text);
select rls_test.ok('4. old production orders keep their BOM (v1), material plan, names and standard costs',
  (rls_test.ord(rls_test.gid('o1', 'order_id'))).bom_version = 1 and (rls_test.ord(rls_test.gid('o2', 'order_id'))).bom_version = 1
  and rls_test.mats(rls_test.gid('o1', 'order_id')) = rls_test.get('o1_mats') and rls_test.mats(rls_test.gid('o2', 'order_id')) = rls_test.get('o2_mats')
  and (rls_test.ord(rls_test.gid('o1', 'order_id'))).product_name_snapshot = 'Basin set');
select rls_test.ok('5. new production orders use the latest approved BOM (v2: 3 bowls per set, drain plug) and current versions and costs',
  (rls_test.ord(rls_test.gid('o3', 'order_id'))).bom_version = 2 and jsonb_array_length(rls_test.mats(rls_test.gid('o3', 'order_id'))) = 3
  and (rls_test.mats(rls_test.gid('o3', 'order_id')) -> 0 ->> 'planned')::numeric = 12
  and rls_test.mats(rls_test.gid('o3', 'order_id')) -> 0 ->> 'name' = 'Ceramic bowl (new glaze)' and (rls_test.mats(rls_test.gid('o3', 'order_id')) -> 0 ->> 'cost')::numeric = 12
  and (rls_test.ord(rls_test.gid('o3', 'order_id'))).product_name_snapshot = 'Basin set Deluxe', rls_test.mats(rls_test.gid('o3', 'order_id'))::text);

-- ---------------------------------------------------------------------------
-- 6/7/8. History unchanged: ledger, costs, reports, lists
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.set('mv_after', rls_test.call(rls_test.report('STOCK_MOVEMENTS')));
select rls_test.set('cons_after', rls_test.call(rls_test.report('MATERIAL_CONSUMPTION')));
select rls_test.set('reg_after', rls_test.call(rls_test.report('PRODUCTION_REGISTER')));
select rls_test.set('grn_after', rls_test.call(rls_test.report('GRN_REGISTER')));
select rls_test.set('cost_after', rls_test.call(rls_test.preport('COST_SUMMARY')));
select rls_test.set('pvac_after', rls_test.call(rls_test.preport('PLANNED_VS_ACTUAL_CONSUMPTION')));
select rls_test.set('sum_after', rls_test.call(rls_test.preport('ORDERS_SUMMARY')));
select rls_test.set('list_after', rls_test.call('select coalesce(jsonb_agg(jsonb_build_object(''n'', transaction_number, ''sku'', sku, ''name'', product_name) order by transaction_number), ''[]'') from public.inventory_transaction_list'));
select rls_test.set('olist_after', rls_test.call('select coalesce(jsonb_agg(jsonb_build_object(''n'', production_order_number, ''sku'', sku, ''name'', product_name) order by production_order_number), ''[]'') from public.production_order_list'));
select rls_test.expect_call_ok('receipt after the change', 'g_ca2', rls_test.grn(rls_test.id('ca'), 5, 11));
select rls_test.set('mv_new', rls_test.call(rls_test.report('STOCK_MOVEMENTS')));
reset role;
select rls_test.ok('6. historical inventory unchanged: every posted stock entry identical (quantity, unit, rate, date, snapshot)',
  (select coalesce(jsonb_agg(t order by t ->> 'transaction_number'), '[]') from jsonb_array_elements(rls_test.ledger(rls_test.id('company_a'))) t
   where t ->> 'transaction_number' in (select x ->> 'transaction_number' from jsonb_array_elements(rls_test.get('ledger_before')) x)) = rls_test.get('ledger_before'));
select rls_test.ok('7. historical product costs unchanged: production cost summary (incl. standard estimate) identical; estimate uses the costs at planning (200, not 240)',
  rls_test.rows_for(rls_test.get('cost_after'), 'order_id', rls_test.gid('o1', 'order_id')::text) = rls_test.rows_for(rls_test.get('cost_before'), 'order_id', rls_test.gid('o1', 'order_id')::text)
  and (rls_test.rows_for(rls_test.get('cost_after'), 'order_id', rls_test.gid('o1', 'order_id')::text) -> 0 ->> 'standard_estimate_for_output')::numeric = 200,
  rls_test.get('cost_after')::text);
select rls_test.ok('8. stock movement report: earlier movements unchanged (names and versions at posting time)',
  rls_test.get('mv_after') -> 'rows' = rls_test.get('mv_before') -> 'rows', (rls_test.get('mv_after') -> 'rows')::text);
select rls_test.ok('8. material consumption, production register (old orders) and GRN register unchanged after the master changes',
  rls_test.get('cons_after') -> 'rows' = rls_test.get('cons_before') -> 'rows'
  and rls_test.rows_for(rls_test.get('reg_after'), 'id', rls_test.gid('o1', 'order_id')::text) = rls_test.rows_for(rls_test.get('reg_before'), 'id', rls_test.gid('o1', 'order_id')::text)
  and rls_test.rows_for(rls_test.get('reg_after'), 'id', rls_test.gid('o2', 'order_id')::text) = rls_test.rows_for(rls_test.get('reg_before'), 'id', rls_test.gid('o2', 'order_id')::text)
  and rls_test.rows_for(rls_test.get('reg_before'), 'id', rls_test.gid('o1', 'order_id')::text) -> 0 ->> 'product_name' = 'Basin set'
  and rls_test.get('grn_after') -> 'rows' = rls_test.get('grn_before') -> 'rows', (rls_test.get('reg_after') -> 'rows')::text);
select rls_test.ok('8. production reports (orders summary, planned vs actual consumption) unchanged for the old orders',
  rls_test.rows_for(rls_test.get('pvac_after'), 'production_order_number', (rls_test.ord(rls_test.gid('o1', 'order_id'))).production_order_number)
    = rls_test.rows_for(rls_test.get('pvac_before'), 'production_order_number', (rls_test.ord(rls_test.gid('o1', 'order_id'))).production_order_number)
  and rls_test.rows_for(rls_test.get('sum_after'), 'production_order_number', (rls_test.ord(rls_test.gid('o2', 'order_id'))).production_order_number)
    = rls_test.rows_for(rls_test.get('sum_before'), 'production_order_number', (rls_test.ord(rls_test.gid('o2', 'order_id'))).production_order_number));
select rls_test.ok('8. lists (stock movements, production orders) show the names at the time',
  rls_test.get('list_after') = rls_test.get('list_before')
  and (select count(*) from jsonb_array_elements(rls_test.get('olist_after')) x where x ->> 'name' = 'Basin set') = 2);
select rls_test.ok('8. reports carry version identifiers and the old values: v1 "Ceramic bowl" for the old receipt, v2 new name for the new one',
  exists (select 1 from jsonb_array_elements(rls_test.get('mv_new') -> 'rows') r where r ->> 'sku' = 'MV-CA' and r ->> 'product_name' = 'Ceramic bowl' and r ->> 'product_version' = 'v1')
  and exists (select 1 from jsonb_array_elements(rls_test.get('mv_new') -> 'rows') r where r ->> 'product_name' = 'Ceramic bowl (new glaze)' and r ->> 'product_version' = 'v2')
  and exists (select 1 from jsonb_array_elements(rls_test.get('cons_after') -> 'rows') r where r ->> 'component_version' = 'v1' and r ->> 'bom' like '% v1'),
  (rls_test.get('mv_new') -> 'rows')::text);
select rls_test.ok('12. legacy records intact: the legacy stock entry still has no version, and reports show it as Legacy / Unversioned with the baseline name',
  exists (select 1 from jsonb_array_elements(rls_test.ledger(rls_test.id('company_a'))) t where t ->> 'product_id' = rls_test.id('legacy')::text and t ->> 'product_version_id' is null)
  and exists (select 1 from jsonb_array_elements(rls_test.get('mv_new') -> 'rows') r where r ->> 'sku' = 'MV-OLD' and r ->> 'product_name' = 'Old washer'
              and r ->> 'product_version' = 'Legacy / Unversioned'));

-- ---------------------------------------------------------------------------
-- Released orders: snapshot fixed; revisions only through Edit
-- ---------------------------------------------------------------------------
select rls_test.expect_call_error('5. a released order''s material plan cannot be changed directly',
  format('update public.production_order_materials set planned_quantity = 99 where production_order_id = %L', rls_test.gid('o2', 'order_id')), 'released production order');
select rls_test.expect_call_error('5. a released order''s quantity cannot be changed directly',
  format('update public.production_orders set planned_quantity = 99 where id = %L', rls_test.gid('o2', 'order_id')), 'is released');
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('draft rule: order 2 (BOM v1) is reported as using older versions than the current ones', 'o2_check',
  format('select public.draft_version_check(''PRODUCTION_ORDER'', %L)', rls_test.gid('o2', 'order_id')));
select rls_test.expect_call_ok('5. revision through Edit, keeping the planned versions: order 2 to 6 sets', 'o2e',
  rls_test.order_save(rls_test.gid('o2', 'order_id'), jsonb_build_object('planned_quantity', 6)));
reset role;
select rls_test.ok('draft rule: the check lists the BOM version and the component versions (old -> current), refreshable',
  (rls_test.get('o2_check') ->> 'stale')::boolean
  and exists (select 1 from jsonb_array_elements(rls_test.get('o2_check') -> 'items') i where i ->> 'field' = 'BOM version' and i ->> 'draft_value' like '% v1' and i ->> 'current_value' like '% v2')
  and exists (select 1 from jsonb_array_elements(rls_test.get('o2_check') -> 'items') i where i ->> 'field' = 'Component version' and i ->> 'draft_value' like 'v1%Ceramic bowl%'),
  rls_test.get('o2_check')::text);
select rls_test.ok('5. no silent change: the edited order keeps BOM v1 and its component versions, names and costs; quantities re-planned; revision recorded',
  (rls_test.ord(rls_test.gid('o2', 'order_id'))).bom_version = 1
  and (rls_test.mats(rls_test.gid('o2', 'order_id')) -> 0 ->> 'name') = 'Ceramic bowl' and (rls_test.mats(rls_test.gid('o2', 'order_id')) -> 0 ->> 'cost')::numeric = 10
  and (rls_test.mats(rls_test.gid('o2', 'order_id')) -> 0 ->> 'planned')::numeric = 6
  and (rls_test.ord(rls_test.gid('o2', 'order_id'))).product_name_snapshot = 'Basin set'
  and rls_test.revisions(rls_test.gid('o2', 'order_id')) @> array['HEADER', 'MATERIAL_CHANGED'],
  rls_test.mats(rls_test.gid('o2', 'order_id'))::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('5. revision through Edit, choosing the latest versions explicitly', 'o2l',
  rls_test.order_save(rls_test.gid('o2', 'order_id'), jsonb_build_object('use_latest_versions', true)));
reset role;
select rls_test.ok('5. the explicit choice moves the order to BOM v2 and the current versions; the previous plan is kept in the revisions',
  (rls_test.ord(rls_test.gid('o2', 'order_id'))).bom_version = 2 and jsonb_array_length(rls_test.mats(rls_test.gid('o2', 'order_id'))) = 3
  and (rls_test.mats(rls_test.gid('o2', 'order_id')) -> 0 ->> 'name') = 'Ceramic bowl (new glaze)'
  and (rls_test.ord(rls_test.gid('o2', 'order_id'))).product_name_snapshot = 'Basin set Deluxe'
  and (select count(*) from public.production_order_revisions where production_order_id = rls_test.gid('o2', 'order_id') and kind = 'HEADER'
       and previous ->> 'bom_version' = '1' and changed_by = rls_test.id('op') and reason is not null) >= 1,
  array_to_string(rls_test.revisions(rls_test.gid('o2', 'order_id')), ','));

-- ---------------------------------------------------------------------------
-- Automatic activation: saving a change creates and activates the next version
-- ---------------------------------------------------------------------------
create function rls_test.save_activate(p_bom uuid, p_items jsonb, p_reason text) returns text language sql stable as $$
  select format('select public.production_bom_save_and_activate(%L, %L, %L, null, 1, null, %L::jsonb, %L, %L, null)',
    p_bom, rls_test.id('fg'), rls_test.today() - 5, p_items, gen_random_uuid(), p_reason) $$;
grant execute on function rls_test.save_activate(uuid, jsonb, text) to authenticated;
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('activation: a change to an approved BOM needs a reason',
  rls_test.save_activate(rls_test.gid('bom2', 'bom_id'), jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('ca'), 'quantity_required', 4)), null), 'reason');
select rls_test.expect_call_ok('activation: saving a change to the active v2 (4 bowls) creates v3 and activates it in one step', 'act3',
  rls_test.save_activate(rls_test.gid('bom2', 'bom_id'), jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('ca'), 'quantity_required', 4),
    jsonb_build_object('component_product_id', rls_test.id('cb'), 'quantity_required', 2), jsonb_build_object('component_product_id', rls_test.id('cnew'), 'quantity_required', 1)), 'Four-bowl design'));
select rls_test.expect_call_ok('history after activation', 'hist3', format('select public.bom_version_history(%L)', rls_test.gid('bom1', 'bom_id')));
select rls_test.claims('viewer');
select rls_test.expect_call_error('activation: users without the existing activation permission cannot activate (no permission added)',
  rls_test.save_activate(rls_test.gid('bom2', 'bom_id'), '[]'::jsonb, 'x'), 'not allowed');
reset role;
select rls_test.ok('activation: v3 is active at once (no approval queue), effective today (not back-dated), with its reason; v2 untouched',
  (rls_test.bom(rls_test.gid('act3', 'bom_id'))).status = 'APPROVED' and (rls_test.bom(rls_test.gid('act3', 'bom_id'))).version = 3
  and (rls_test.bom(rls_test.gid('act3', 'bom_id'))).effective_from = rls_test.today()
  and (rls_test.bom(rls_test.gid('act3', 'bom_id'))).change_reason = 'Four-bowl design' and (rls_test.get('act3') ->> 'new_version')::boolean
  and (rls_test.bom_items(rls_test.gid('bom2', 'bom_id')) -> 0 ->> 'q')::numeric = 3
  and not exists (select 1 from public.boms where finished_product_id = rls_test.id('fg') and status = 'PENDING_APPROVAL'), rls_test.get('act3')::text);
select rls_test.ok('activation: the previous versions are shown as Superseded (with the version that replaced them); one active version',
  rls_test.get('hist3') -> 'versions' -> 0 ->> 'lifecycle' = 'ACTIVE'
  and rls_test.get('hist3') -> 'versions' -> 1 ->> 'lifecycle' = 'SUPERSEDED' and (rls_test.get('hist3') -> 'versions' -> 1 ->> 'superseded_by')::int = 3
  and rls_test.get('hist3') -> 'versions' -> 2 ->> 'lifecycle' = 'SUPERSEDED'
  and (select count(*) from public.boms where finished_product_id = rls_test.id('fg') and status = 'APPROVED') = 1
  and rls_test.get('hist3') -> 'versions' -> 0 ->> 'modified_at' is not null, rls_test.get('hist3')::text);
select rls_test.ok('activation: component costs per version for the comparison (v1 bowl at 10, v3 bowl at 12)',
  (rls_test.get('hist3') -> 'versions' -> 0 -> 'items' -> 0 ->> 'standard_cost')::numeric = 12
  and (rls_test.get('hist3') -> 'versions' -> 2 -> 'items' -> 0 ->> 'standard_cost')::numeric = 10
  and (rls_test.get('hist3') -> 'versions' -> 0 -> 'items' -> 0 ->> 'line_cost')::numeric = 48);
select rls_test.ok('activation: recorded in the audit log with who and why', exists (select 1 from public.audit_logs where action = 'bom.version_activated'
  and actor_user_id = rls_test.id('op') and metadata ->> 'reason' = 'Four-bowl design'));

-- ---------------------------------------------------------------------------
-- Drafts keep their versions until the user refreshes them
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('draft: v4 started from v3', 'bom4', format('select public.production_new_bom_version(%L, %L)', rls_test.gid('act3', 'bom_id'), gen_random_uuid()));
reset role;
select rls_test.set('bom4_items', rls_test.bom_items(rls_test.gid('bom4', 'bom_id')));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('draft: the bowl changes again (v3 of the component)', 'e_ca3',
  format('update public.products set standard_cost = 13, change_reason = ''Price increase'' where id = %L returning jsonb_build_object(''id'', id)', rls_test.id('ca')));
select rls_test.expect_call_ok('draft: the draft is saved again (quantity change only)', 'bom4_save',
  rls_test.save_bom(rls_test.gid('bom4', 'bom_id'), jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('ca'), 'quantity_required', 5),
    jsonb_build_object('component_product_id', rls_test.id('cb'), 'quantity_required', 2), jsonb_build_object('component_product_id', rls_test.id('cnew'), 'quantity_required', 1))));
reset role;
select rls_test.set('bom4_saved', rls_test.bom_items(rls_test.gid('bom4', 'bom_id')));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('draft: check', 'bom4_check', format('select public.draft_version_check(''BOM'', %L)', rls_test.gid('bom4', 'bom_id')));
select rls_test.expect_call_error('draft: approved versions cannot be refreshed', format('select public.draft_refresh_versions(''BOM'', %L)', rls_test.gid('act3', 'bom_id')), 'never change');
select rls_test.expect_call_error('draft: production orders refresh through Edit', format('select public.draft_refresh_versions(''PRODUCTION_ORDER'', %L)', rls_test.gid('o2', 'order_id')), 'Edit');
select rls_test.claims('viewer');
select rls_test.expect_call_error('draft: a read-only user cannot refresh', format('select public.draft_refresh_versions(''BOM'', %L)', rls_test.gid('bom4', 'bom_id')), 'not allowed');
select rls_test.claims('op');
select rls_test.expect_call_ok('draft: the user chooses to refresh', 'bom4_ref', format('select public.draft_refresh_versions(''BOM'', %L)', rls_test.gid('bom4', 'bom_id')));
select rls_test.expect_call_ok('draft: check again', 'bom4_check2', format('select public.draft_version_check(''BOM'', %L)', rls_test.gid('bom4', 'bom_id')));
select rls_test.claims('b_op');
select rls_test.expect_call_error('11. company B cannot check company A''s drafts', format('select public.draft_version_check(''BOM'', %L)', rls_test.gid('bom4', 'bom_id')), 'not found');
reset role;
select rls_test.ok('draft: re-saving kept the bowl at the version the draft had (no silent change), and the check offers the newer one',
  (rls_test.get('bom4_saved') -> 0 ->> 'q')::numeric = 5
  and rls_test.get('bom4_saved') -> 0 ->> 'v' = rls_test.get('bom4_items') -> 0 ->> 'v'
  and (rls_test.get('bom4_check') ->> 'stale')::boolean
  and rls_test.get('bom4_check') -> 'items' -> 0 ->> 'draft_value' like 'v2%cost 12%' and rls_test.get('bom4_check') -> 'items' -> 0 ->> 'current_value' like 'v3%cost 13%',
  rls_test.get('bom4_check')::text);
select rls_test.ok('draft: after the explicit refresh the draft uses the current version; audited',
  rls_test.bom_items(rls_test.gid('bom4', 'bom_id')) -> 0 ->> 'v' = (rls_test.cur(rls_test.id('ca'))).id::text
  and not (rls_test.get('bom4_check2') ->> 'stale')::boolean and (rls_test.get('bom4_ref') ->> 'refreshed_lines')::int = 1
  and exists (select 1 from public.audit_logs where action = 'draft.versions_refreshed' and resource_id = rls_test.gid('bom4', 'bom_id')::text));
select rls_test.ok('integrity: activation and refresh rewrote nothing historical (v1 lines, order 1 plan, posted stock entries)',
  rls_test.bom_items(rls_test.gid('bom1', 'bom_id')) = rls_test.get('bom1_items') and rls_test.mats(rls_test.gid('o1', 'order_id')) = rls_test.get('o1_mats')
  and (select coalesce(jsonb_agg(t order by t ->> 'transaction_number'), '[]') from jsonb_array_elements(rls_test.ledger(rls_test.id('company_a'))) t
       where t ->> 'transaction_number' in (select x ->> 'transaction_number' from jsonb_array_elements(rls_test.get('ledger_before')) x)) = rls_test.get('ledger_before'));

-- ---------------------------------------------------------------------------
-- 10. Read-only history and permissions; overlap check
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('10. versions cannot be edited by users', format('update public.product_versions set product_name = ''x'' where product_id = %L returning jsonb_build_object(''id'', id)', rls_test.id('ca')), 'permission denied');
select rls_test.expect_call_error('10. versions cannot be deleted by users', format('delete from public.product_versions where product_id = %L returning jsonb_build_object(''id'', id)', rls_test.id('ca')), 'permission denied');
select rls_test.expect_call_error('10. production revisions cannot be written by users',
  format('insert into public.production_order_revisions (company_id, production_order_id, kind, previous) values (%L, %L, ''HEADER'', ''{}'') returning jsonb_build_object(''id'', id)',
    rls_test.id('company_a'), rls_test.gid('o2', 'order_id')), 'permission denied');
select rls_test.claims('viewer');
select rls_test.set('viewer_versions', rls_test.call(format('select to_jsonb(count(*)) from public.product_versions where product_id = %L', rls_test.id('ca'))));
select rls_test.set('viewer_update', rls_test.call(format('update public.products set product_name = ''Hack'' where id = %L returning jsonb_build_object(''id'', id)', rls_test.id('ca'))));
select rls_test.expect_call_error('10. a read-only user cannot set BOM version details', format('select public.bom_version_details_save(%L, ''x'', null)', rls_test.gid('bom2', 'bom_id')), 'not allowed');
reset role;
select rls_test.ok('10. a read-only user can read the history but changes nothing (the product update is refused or matches no row)',
  rls_test.get('viewer_versions') = to_jsonb(rls_test.version_count(rls_test.id('ca')))
  and (rls_test.get('viewer_update') = 'null'::jsonb or rls_test.get('viewer_update') ? 'sqlstate')
  and (select product_name from public.products where id = rls_test.id('ca')) = 'Ceramic bowl (new glaze)');
select rls_test.expect_call_error('10. even the database owner cannot rewrite a historical version',
  format('update public.product_versions set standard_cost = 1 where product_id = %L and version_no = 1', rls_test.id('ca')), 'read-only');
select rls_test.expect_call_error('10. nor reopen a closed one',
  format('update public.product_versions set is_current = true, effective_to = null where product_id = %L and version_no = 1', rls_test.id('ca')), 'read-only');
select rls_test.expect_call_error('10. nor delete one', format('delete from public.product_versions where product_id = %L', rls_test.id('ca')), 'permanent');
-- Overlap: another approved version over the same period is refused.
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('setup: draft v3', 'bom3', format('select public.production_new_bom_version(%L, %L)', rls_test.gid('bom2', 'bom_id'), gen_random_uuid()));
reset role;
set constraints public.boms_no_overlap immediate;
select rls_test.expect_call_error('4. two approved versions effective at the same time are refused',
  format('update public.boms set status = ''APPROVED'', approved_by = %L, approved_at = now() where id = %L', rls_test.id('op'), rls_test.gid('bom3', 'bom_id')), 'same time');
set constraints all deferred;

-- ---------------------------------------------------------------------------
-- 11. Company isolation
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('b_op');
select rls_test.set('b_versions', rls_test.call('select to_jsonb(count(*)) from public.product_versions'));
select rls_test.set('b_revisions', rls_test.call('select to_jsonb(count(*)) from public.production_order_revisions'));
select rls_test.expect_call_error('11. company B cannot read company A''s product history', format('select public.product_version_history(%L)', rls_test.id('ca')), 'not found');
select rls_test.expect_call_error('11. nor its BOM history', format('select public.bom_version_history(%L)', rls_test.gid('bom1', 'bom_id')), 'not found');
reset role;
select rls_test.ok('11. company B sees none of company A''s versions or revisions', rls_test.get('b_versions') = '0'::jsonb and rls_test.get('b_revisions') = '0'::jsonb);
select rls_test.ok('security: RLS on the new tables; clients have SELECT only; anon nothing',
  (select relrowsecurity from pg_class where oid = 'public.product_versions'::regclass) and (select relrowsecurity from pg_class where oid = 'public.production_order_revisions'::regclass)
  and not has_table_privilege('authenticated', 'public.product_versions', 'INSERT,UPDATE,DELETE')
  and not has_table_privilege('anon', 'public.product_versions', 'SELECT')
  and not has_function_privilege('anon', 'public.product_version_history(uuid)', 'EXECUTE'));
select rls_test.ok('ERP reset: versions kept by the standard reset and purged by the force reset; revisions deleted with the orders',
  exists (select 1 from private.erp_reset_kept_tables() where table_name = 'product_versions')
  and exists (select 1 from private.erp_force_reset_tables() where table_name = 'product_versions')
  and exists (select 1 from private.erp_reset_tables() where table_name = 'production_order_revisions'));

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
  raise exception 'MASTER_VERSIONING_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
