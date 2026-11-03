-- =============================================================================
-- BOM PLANNING FIELDS AND PRODUCT MASTER EAN (ALTON ERP V2)
-- migration 20261114090000_bom_planning_product_ean.sql
--
--   EAN: format and check digit (same rule as the screen), unique per company,
--        allowed again in another company, optional (existing products unaffected)
--   Group head / minimum stock days: constraints; ERP setting list validated;
--        options = configured + in use, per company
--   bom_list_v2: BOM rows with the finished product's planning fields, RLS applies
--   Stock calculations do not change when planning fields are set
--
-- Runs in one transaction and ALWAYS ends by raising
--   BOM_PLANNING_EAN_RESULT passed=N failed=M
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
create function rls_test.expect_call_ok(p_name text, p_key text, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.set(p_key, r); perform rls_test.ok(p_name, not (r ? 'error'), r::text); return r; end $$;
create function rls_test.expect_call_error(p_name text, p_sql text, p_pattern text default null) returns void language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.ok(p_name, r ? 'error' and (p_pattern is null or r ->> 'error' ilike '%' || p_pattern || '%' or r ->> 'sqlstate' = p_pattern), r::text); end $$;
create function rls_test.claims(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', rls_test.id(p_key), 'role', 'authenticated')::text, true) $$;
-- An UPDATE / INSERT through PostgREST-like SQL, returning the row as jsonb.
create function rls_test.upd(p_id uuid, p_set text) returns text language sql stable as $$
  select format('update public.products set %s where id = %L returning jsonb_build_object(''id'', id, ''ean'', ean, ''group_head'', group_head, ''minimum_cover_days'', minimum_cover_days)', p_set, p_id) $$;
grant execute on all functions in schema rls_test to anon, authenticated;

insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5cf00-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5cf00-0000-4000-8000-0000000000b1'),
  ('op', 'e7e5cf00-0000-4000-8000-000000000001'), ('viewer', 'e7e5cf00-0000-4000-8000-000000000002'), ('b_op', 'e7e5cf00-0000-4000-8000-000000000003'),
  ('fg', 'e7e5cf00-0000-4000-8000-0000000000d1'), ('fg2', 'e7e5cf00-0000-4000-8000-0000000000d2'), ('rm', 'e7e5cf00-0000-4000-8000-0000000000d3'),
  ('old', 'e7e5cf00-0000-4000-8000-0000000000d4'), ('fgb', 'e7e5cf00-0000-4000-8000-0000000000d5'),
  ('w1', 'e7e5cf00-0000-4000-8000-0000000000e1');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code, gstin, legal_address) values
  (rls_test.id('company_a'), 'BOM Planning A Pvt Ltd', 'BP A', 'BPA', '27AAACB1234A1Z5', 'Pune'),
  (rls_test.id('company_b'), 'BOM Planning B Pvt Ltd', 'BP B', 'BPB', '27AAACB5678B1Z5', 'Nashik');
insert into auth.users (id, email) select id, key || '@bp.example.invalid' from rls_test.ids where key in ('op', 'viewer', 'b_op');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id in (rls_test.id('op'), rls_test.id('viewer'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_op');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('op'), rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_management_viewer')),
  (rls_test.id('b_op'), rls_test.id('company_b'), rls_test.id('role_super_admin'));
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, status, gst_rate, lead_time_days, reorder_level_days) values
  (rls_test.id('fg'), rls_test.id('company_a'), 'BP-FG', 'Wall-hung closet', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', 18, 10, 20),
  (rls_test.id('fg2'), rls_test.id('company_a'), 'BP-FG2', 'Basin', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', null, null, null),
  (rls_test.id('rm'), rls_test.id('company_a'), 'BP-RM', 'Clay', 'RAW_MATERIAL', 'OUTSOURCED', 'KG', 'ACTIVE', 5, null, null),
  (rls_test.id('old'), rls_test.id('company_a'), 'BP-OLD', 'Existing product without EAN', 'COMPONENT', 'IN_HOUSE', 'PCS', 'ACTIVE', 12, null, null),
  (rls_test.id('fgb'), rls_test.id('company_b'), 'BP-FG', 'B closet', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', 18, null, null);
insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Factory', true);
insert into rls_test.ids (key, id) select 'g1', id from public.inventory_locations where warehouse_id = rls_test.id('w1') and location_code = 'GENERAL';

-- ---------------------------------------------------------------------------
-- EAN rule (same vectors as tests/unit/bom-planning-ean.test.ts)
-- ---------------------------------------------------------------------------
select rls_test.ok('EAN rule: valid EAN-13 / EAN-8 accepted', private.ean_valid('4006381333931') and private.ean_valid('96385074') and private.ean_valid('8901030865275'));
select rls_test.ok('EAN rule: wrong check digit, wrong length, letters refused',
  not private.ean_valid('4006381333932') and not private.ean_valid('96385075') and not private.ean_valid('123456789012')
  and not private.ean_valid('40063813339A1') and not private.ean_valid('4006 3813 3393 1'));
select rls_test.ok('schema: new columns are optional; existing products have no EAN, group head or minimum stock days',
  (select count(*) from public.products where company_id = rls_test.id('company_a') and (ean is not null or group_head is not null or minimum_cover_days is not null)) = 0
  and exists (select 1 from pg_indexes where indexname = 'products_company_ean_unique' and indexdef ilike '%(company_id, ean)%'));

-- ---------------------------------------------------------------------------
-- Create / update with EAN through the API role (column grants + RLS)
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('6. EAN set on a product (update)', 'u1', rls_test.upd(rls_test.id('fg'), 'ean = ''4006381333931'', group_head = ''Sanitaryware'', minimum_cover_days = 15'));
select rls_test.expect_call_ok('6. product created with an EAN', 'c1',
  format('insert into public.products (company_id, sku, product_name, product_type, base_unit, ean, group_head) values (%L, ''BP-NEW'', ''New tap'', ''FINISHED_GOOD'', ''PCS'', ''96385074'', ''Faucets'') returning jsonb_build_object(''id'', id, ''ean'', ean)', rls_test.id('company_a')));
select rls_test.expect_call_error('9. duplicate EAN in the same company refused', rls_test.upd(rls_test.id('fg2'), 'ean = ''4006381333931'''), '23505');
select rls_test.expect_call_error('EAN with a wrong check digit refused by the database', rls_test.upd(rls_test.id('fg2'), 'ean = ''4006381333932'''), 'products_ean_format');
select rls_test.expect_call_error('EAN of 12 digits refused', rls_test.upd(rls_test.id('fg2'), 'ean = ''400638133393'''), 'products_ean_format');
select rls_test.expect_call_error('group head over 100 characters refused', rls_test.upd(rls_test.id('fg2'), format('group_head = %L', repeat('x', 101))), 'products_group_head_length');
select rls_test.expect_call_error('minimum stock days over 3650 refused', rls_test.upd(rls_test.id('fg2'), 'minimum_cover_days = 4000'), 'products_minimum_cover_days_range');
select rls_test.expect_call_error('negative minimum stock days refused', rls_test.upd(rls_test.id('fg2'), 'minimum_cover_days = -1'), 'products_minimum_cover_days_range');
select rls_test.expect_call_ok('10. an existing product without EAN can still be edited normally', 'u_old', rls_test.upd(rls_test.id('old'), 'product_name = ''Existing product, renamed'''));
select rls_test.claims('viewer');
select rls_test.set('v_upd', rls_test.call(rls_test.upd(rls_test.id('fg2'), 'ean = ''96385074''')));
reset role;
select rls_test.ok('6. stored: EAN, group head and minimum stock days of BP-FG; new product with its EAN',
  (select ean = '4006381333931' and group_head = 'Sanitaryware' and minimum_cover_days = 15 from public.products where id = rls_test.id('fg'))
  and exists (select 1 from public.products where sku = 'BP-NEW' and ean = '96385074'));
select rls_test.ok('10. the existing product keeps EAN null and its other data', (select ean is null and gst_rate = 12 and product_name = 'Existing product, renamed' from public.products where id = rls_test.id('old')));
select rls_test.ok('permissions: a viewer cannot set an EAN (no product changed)',
  (rls_test.get('v_upd') ? 'error' or rls_test.get('v_upd') = '{}'::jsonb) and (select ean is null from public.products where id = rls_test.id('fg2')), rls_test.get('v_upd')::text);

-- Same EAN in another company is allowed (uniqueness is per company); B cannot see A's products.
set local role authenticated;
select rls_test.claims('b_op');
select rls_test.expect_call_ok('15. company B may use the same EAN for its own product', 'b_upd', rls_test.upd(rls_test.id('fgb'), 'ean = ''4006381333931'''));
select rls_test.set('b_sees_a', rls_test.call(format('select to_jsonb(count(*)) from public.products where ean = ''4006381333931'' and company_id = %L', rls_test.id('company_a'))));
reset role;
select rls_test.ok('15. company B sees none of company A''s products by EAN', rls_test.get('b_sees_a') = '0'::jsonb, rls_test.get('b_sees_a')::text);

-- ---------------------------------------------------------------------------
-- Group heads: ERP setting and options
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('settings: group heads saved', 'gh', 'select public.erp_settings_save(''{}''::jsonb, ''{"product.group_heads": ["Sanitaryware", "Faucets", "Accessories"]}''::jsonb)');
select rls_test.expect_call_error('settings: a blank group head is refused', 'select public.erp_settings_save(''{}''::jsonb, ''{"product.group_heads": ["Sanitaryware", " "]}''::jsonb)', 'Group heads');
select rls_test.expect_call_error('settings: repeated group heads (ignoring case) are refused', 'select public.erp_settings_save(''{}''::jsonb, ''{"product.group_heads": ["Faucets", "faucets"]}''::jsonb)', 'Group heads');
select rls_test.expect_call_error('settings: group heads must be a list of names', 'select public.erp_settings_save(''{}''::jsonb, ''{"product.group_heads": "Sanitaryware"}''::jsonb)', 'Group heads');
select rls_test.call(rls_test.upd(rls_test.id('fg2'), 'group_head = ''Wellness'''));
select rls_test.expect_call_ok('options: configured list and values in use', 'opts', 'select public.product_group_head_options()');
select rls_test.claims('b_op');
select rls_test.expect_call_ok('options: company B', 'opts_b', 'select public.product_group_head_options()');
reset role;
select rls_test.ok('options: configured first, then other values in use (no repeats)',
  rls_test.get('opts') -> 'configured' = '["Sanitaryware", "Faucets", "Accessories"]'::jsonb and rls_test.get('opts') -> 'in_use' = '["Wellness"]'::jsonb,
  rls_test.get('opts')::text);
select rls_test.ok('settings: product.group_heads is a known setting with an empty default', private.erp_setting_defaults() -> 'product.group_heads' = '[]'::jsonb);
select rls_test.ok('15. options are per company (B has none)', rls_test.get('opts_b') = '{"configured": [], "in_use": []}'::jsonb, rls_test.get('opts_b')::text);
select rls_test.ok('grants: anon cannot call the options RPC; authenticated can read bom_list_v2 (RLS applies)',
  not has_function_privilege('anon', 'public.product_group_head_options()', 'EXECUTE')
  and has_table_privilege('authenticated', 'public.bom_list_v2', 'SELECT') and not has_table_privilege('anon', 'public.bom_list_v2', 'SELECT'));

-- ---------------------------------------------------------------------------
-- BOM with planning fields; list view; components and stock unchanged
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('setup: 100 KG clay in stock', 'grn', format('select public.goods_receipt_direct_post(%L::jsonb, %L::jsonb, %L)', jsonb_build_object('warehouse_id', rls_test.id('w1')),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('rm'), 'received_quantity', 100, 'accepted_quantity', 100, 'unit_cost', 10, 'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()));
select rls_test.expect_call_ok('1. BOM for BP-FG (18.5 KG clay, 3% wastage)', 'bom',
  format('select public.production_save_bom(null, %L, current_date, null, 1, null, %L::jsonb, %L)', rls_test.id('fg'),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('rm'), 'quantity_required', 18.5, 'wastage_percentage', 3)), gen_random_uuid()));
select rls_test.expect_call_ok('stock position before changing planning fields', 'sp0', 'select public.inventory_stock_position(''{}''::jsonb)');
select rls_test.expect_call_ok('reorder plan before changing planning fields', 'rp0', 'select public.inventory_reorder_plan(90)');
select rls_test.expect_call_ok('2. edit the new planning fields of the BOM product (group head, 30 minimum stock days)', 'u2',
  rls_test.upd(rls_test.id('fg'), 'group_head = ''Faucets'', minimum_cover_days = 30'));
select rls_test.expect_call_ok('stock position after', 'sp1', 'select public.inventory_stock_position(''{}''::jsonb)');
select rls_test.expect_call_ok('reorder plan after', 'rp1', 'select public.inventory_reorder_plan(90)');
-- Tax rate and lead time are the existing product fields (lead time is shown in reorder planning as before).
select rls_test.expect_call_ok('2. edit tax rate 12 and lead time 14 from the BOM', 'u2b', rls_test.upd(rls_test.id('fg'), 'gst_rate = 12, lead_time_days = 14'));
select rls_test.expect_call_ok('BOM list v2', 'list', format('select to_jsonb(l) from public.bom_list_v2 l where l.id = %L', (rls_test.get('bom') ->> 'bom_id')::uuid));
select rls_test.claims('b_op');
select rls_test.set('b_list', rls_test.call('select to_jsonb(count(*)) from public.bom_list_v2'));
reset role;
select rls_test.ok('BOM list v2: product name, type, tax rate, lead time, group head and minimum stock days of the finished product',
  rls_test.get('list') ->> 'product_name' = 'Wall-hung closet' and rls_test.get('list') ->> 'product_type' = 'FINISHED_GOOD'
  and (rls_test.get('list') ->> 'tax_rate')::numeric = 12 and (rls_test.get('list') ->> 'lead_time_days')::numeric = 14
  and rls_test.get('list') ->> 'group_head' = 'Faucets' and (rls_test.get('list') ->> 'minimum_cover_days')::numeric = 30
  and (rls_test.get('list') ->> 'item_count')::int = 1 and rls_test.get('list') ->> 'ean' = '4006381333931', rls_test.get('list')::text);
select rls_test.ok('11. BOM components unchanged (quantity, unit, wastage)',
  (select quantity_required = 18.5 and unit = 'KG' and wastage_percentage = 3 from public.bom_items where bom_id = (rls_test.get('bom') ->> 'bom_id')::uuid));
select rls_test.ok('11. stock position and reorder plan are identical before and after setting group head and minimum stock days (no stock calculation uses them)',
  rls_test.get('sp0') -> 'rows' = rls_test.get('sp1') -> 'rows' and (rls_test.get('rp0') - 'generated_at' - 'as_of') = (rls_test.get('rp1') - 'generated_at' - 'as_of'),
  jsonb_build_object('rp0', rls_test.get('rp0'), 'rp1', rls_test.get('rp1'))::text);
select rls_test.ok('15. company B sees none of company A''s BOMs in bom_list_v2', rls_test.get('b_list') = '0'::jsonb);

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
  raise exception 'BOM_PLANNING_EAN_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
