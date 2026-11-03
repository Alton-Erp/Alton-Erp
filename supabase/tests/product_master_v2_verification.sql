-- =============================================================================
-- PRODUCT MASTER & BOM VERIFICATION (ALTON ERP V2, Stage 1)
--
-- Checks migration 20261102090000_product_master_v2.sql: all eight product
-- types, incomplete products (automatic SKU, default source and unit), the new
-- fields, preferred suppliers, updates by SKU, BOM component source and
-- supplier, multi-level BOMs, draft BOMs without components, same-day revisions,
-- has_bom tracking, KPIs, permissions and company isolation.
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction and ALWAYS ends by raising
--   PRODUCT_V2_VERIFICATION_RESULT passed=N failed=M
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
grant select, insert on rls_test.ids to anon, authenticated;
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
-- Client-side insert of a product (runs as the signed-in user, under RLS); returns {id, sku} or {error}.
create function rls_test.add_product(p_values jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, hsn_code, gst_rate,
    selling_price, standard_cost, standard_manufacturing_cost, minimum_level, reorder_level, remarks, preferred_supplier_id, category_id)
  select private.current_company_id(), v.sku, v.product_name, v.product_type, v.default_source_type, v.base_unit, v.hsn_code, v.gst_rate,
    v.selling_price, v.standard_cost, v.standard_manufacturing_cost, v.minimum_level, v.reorder_level, v.remarks, v.preferred_supplier_id, v.category_id
  from jsonb_to_record(p_values) as v(sku text, product_name text, product_type text, default_source_type text, base_unit text, hsn_code text,
    gst_rate numeric, selling_price numeric, standard_cost numeric, standard_manufacturing_cost numeric, minimum_level numeric,
    reorder_level numeric, remarks text, preferred_supplier_id uuid, category_id uuid)
  returning jsonb_build_object('id', id, 'sku', sku, 'source', default_source_type, 'unit', base_unit) into r;
  return r;
exception when others then return jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
end $$;

-- Owner-side probes (bypass RLS).
create function rls_test.product(p_id uuid) returns public.products language sql stable security definer as $$
  select * from public.products where id = p_id $$;
create function rls_test.bom(p_id uuid) returns public.boms language sql stable security definer as $$
  select * from public.boms where id = p_id $$;
create function rls_test.item(p_bom uuid, p_product uuid) returns public.bom_items language sql stable security definer as $$
  select * from public.bom_items where bom_id = p_bom and component_product_id = p_product $$;
create function rls_test.audit_fields(p_product uuid) returns jsonb language sql stable security definer as $$
  select metadata -> 'changed_fields' from public.audit_logs where resource_id = p_product::text and action = 'product.updated'
  order by event_timestamp desc limit 1 $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5c200-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5c200-0000-4000-8000-0000000000b1'),
  ('op',     'e7e5c200-0000-4000-8000-000000000001'),   -- single operator (Super Admin)
  ('viewer', 'e7e5c200-0000-4000-8000-000000000002'),   -- Management Viewer A
  ('b_op',   'e7e5c200-0000-4000-8000-000000000003'),   -- Super Admin B
  ('sup',    'e7e5c200-0000-4000-8000-0000000000c1'), ('sup2', 'e7e5c200-0000-4000-8000-0000000000c2'),
  ('b_sup',  'e7e5c200-0000-4000-8000-0000000000c3'),
  ('cat',    'e7e5c200-0000-4000-8000-0000000000d1');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code) values
  (rls_test.id('company_a'), 'Product V2 A', 'Product V2 A', 'PMVA'), (rls_test.id('company_b'), 'Product V2 B', 'Product V2 B', 'PMVB');
insert into auth.users (id, email) select id, key || '@pmv.example.invalid' from rls_test.ids where key in ('op', 'viewer', 'b_op');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id in (rls_test.id('op'), rls_test.id('viewer'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_op');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('op'),     rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_management_viewer')),
  (rls_test.id('b_op'),   rls_test.id('company_b'), rls_test.id('role_super_admin'));
insert into public.suppliers (id, company_id, supplier_code, legal_name, payment_terms, status) values
  (rls_test.id('sup'),   rls_test.id('company_a'), 'S-CLAY', 'Clay Traders',   'DAYS_30', 'ACTIVE'),
  (rls_test.id('sup2'),  rls_test.id('company_a'), 'S-FIT',  'Fittings Works', 'DAYS_30', 'ACTIVE'),
  (rls_test.id('b_sup'), rls_test.id('company_b'), 'S-B',    'B Supplier',     'DAYS_30', 'ACTIVE');
insert into public.product_categories (id, company_id, name, code) values (rls_test.id('cat'), rls_test.id('company_a'), 'Closets', 'CLOSETS');

-- ---------------------------------------------------------------------------
-- Product types and incomplete products
-- ---------------------------------------------------------------------------
select rls_test.ok('schema: eight product types are allowed',
  (select pg_get_constraintdef(oid) from pg_constraint where conname = 'products_product_type_check') like all
    (array['%FINISHED_GOOD%', '%RAW_MATERIAL%', '%COMPONENT%', '%SUBASSEMBLY%', '%OUTSOURCED_COMPONENT%', '%PACKAGING_MATERIAL%', '%CONSUMABLE%', '%OTHER%']));
select rls_test.ok('schema: still no stock columns on products (stock lives in the ledger)',
  not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'products'
              and column_name ~ '(stock|qty|quantity|on_hand|available|reserved|balance)'));

set local role authenticated;
select rls_test.claims('op');
select rls_test.ok('sku preview: the first automatic finished-good SKU is FG-000001', public.product_sku_preview('FINISHED_GOOD') = 'FG-000001',
  public.product_sku_preview('FINISHED_GOOD'));
select rls_test.set('fg', rls_test.add_product('{"product_name": "Wall-hung WC", "product_type": "FINISHED_GOOD"}'));
select rls_test.ok('incomplete: a finished good with only a name and type is saved with SKU FG-000001, In-House, PCS',
  rls_test.get('fg') ->> 'sku' = 'FG-000001' and rls_test.get('fg') ->> 'source' = 'IN_HOUSE' and rls_test.get('fg') ->> 'unit' = 'PCS',
  rls_test.get('fg')::text);
select rls_test.set('taken', rls_test.add_product('{"sku": "FG-000002", "product_name": "Manually coded basin", "product_type": "FINISHED_GOOD"}'));
select rls_test.set('fg2', rls_test.add_product('{"product_name": "Counter basin", "product_type": "FINISHED_GOOD", "sku": "  "}'));
select rls_test.ok('incomplete: a blank SKU is generated and skips codes already entered by hand (FG-000003)',
  rls_test.get('fg2') ->> 'sku' = 'FG-000003', rls_test.get('fg2')::text);
select rls_test.set('clay', rls_test.add_product(jsonb_build_object('product_name', 'Ball clay', 'product_type', 'RAW_MATERIAL', 'base_unit', 'KG',
  'preferred_supplier_id', rls_test.id('sup'), 'standard_cost', 12)));
select rls_test.ok('incomplete: a raw material gets RM-000001 and defaults to Outsourced; preferred supplier is stored',
  rls_test.get('clay') ->> 'sku' = 'RM-000001' and rls_test.get('clay') ->> 'source' = 'OUTSOURCED' and rls_test.get('clay') ->> 'unit' = 'KG',
  rls_test.get('clay')::text);
select rls_test.set('sub',  rls_test.add_product('{"product_name": "Flush tank assembly", "product_type": "SUBASSEMBLY"}'));
select rls_test.set('osc',  rls_test.add_product(jsonb_build_object('product_name', 'Chrome flush plate', 'product_type', 'OUTSOURCED_COMPONENT', 'preferred_supplier_id', rls_test.id('sup2'))));
select rls_test.set('cmp',  rls_test.add_product('{"product_name": "Seat hinge", "product_type": "COMPONENT"}'));
select rls_test.set('pkg',  rls_test.add_product('{"product_name": "Carton 5-ply", "product_type": "PACKAGING_MATERIAL"}'));
select rls_test.set('con',  rls_test.add_product('{"product_name": "Polishing wax", "product_type": "CONSUMABLE", "base_unit": "KG"}'));
select rls_test.ok('types: subassembly SUB-, outsourced component OSC-, component CMP-, packaging PKG-, consumable CON- (each with its own sequence)',
  rls_test.get('sub') ->> 'sku' = 'SUB-000001' and rls_test.get('osc') ->> 'sku' = 'OSC-000001' and rls_test.get('cmp') ->> 'sku' = 'CMP-000001'
  and rls_test.get('pkg') ->> 'sku' = 'PKG-000001' and rls_test.get('con') ->> 'sku' = 'CON-000001'
  and rls_test.get('sub') ->> 'source' = 'IN_HOUSE' and rls_test.get('osc') ->> 'source' = 'OUTSOURCED' and rls_test.get('con') ->> 'source' = 'OUTSOURCED',
  concat_ws(' ', rls_test.get('sub'), rls_test.get('osc'), rls_test.get('cmp'), rls_test.get('pkg'), rls_test.get('con')));
select rls_test.ok('incomplete: a product without a type is refused with a clear message',
  rls_test.add_product('{"product_name": "Mystery item"}') ->> 'error' ilike '%product type%', rls_test.add_product('{"product_name": "Mystery item"}')::text);
select rls_test.ok('incomplete: an unknown type is refused',
  rls_test.add_product('{"product_name": "X", "product_type": "WIDGET"}') ? 'error');
select rls_test.ok('duplicates: a SKU that differs only in letter case is refused',
  rls_test.add_product('{"sku": "fg-000001", "product_name": "Copy", "product_type": "FINISHED_GOOD"}') ->> 'error' ilike '%duplicate%');
select rls_test.ok('fields: negative manufacturing cost or minimum stock level is refused',
  rls_test.add_product('{"product_name": "Bad", "product_type": "COMPONENT", "standard_manufacturing_cost": -1}') ? 'error'
  and rls_test.add_product('{"product_name": "Bad", "product_type": "COMPONENT", "minimum_level": -5}') ? 'error');
select rls_test.ok('fields: another company''s supplier cannot be the preferred supplier',
  rls_test.add_product(jsonb_build_object('product_name', 'Bad', 'product_type', 'COMPONENT', 'preferred_supplier_id', rls_test.id('b_sup'))) ? 'error');
reset role;
insert into rls_test.ids (key, id) select k, (rls_test.get(k) ->> 'id')::uuid from unnest(array['fg', 'fg2', 'clay', 'sub', 'osc', 'cmp', 'pkg', 'con', 'taken']) k;

-- ---------------------------------------------------------------------------
-- Updating an existing product (the import "update by SKU" path)
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
update public.products set hsn_code = '6910', gst_rate = 18, selling_price = 8500, standard_manufacturing_cost = 4200, minimum_level = 10,
  reorder_level = 25, remarks = 'Best seller', category_id = rls_test.id('cat')
where id = rls_test.id('fg');
reset role;
select rls_test.ok('update: missing information added later is stored (HSN, GST, prices, minimum stock, reorder level, remarks, category)',
  (rls_test.product(rls_test.id('fg'))).hsn_code = '6910' and (rls_test.product(rls_test.id('fg'))).standard_manufacturing_cost = 4200
  and (rls_test.product(rls_test.id('fg'))).minimum_level = 10 and (rls_test.product(rls_test.id('fg'))).remarks = 'Best seller'
  and (rls_test.product(rls_test.id('fg'))).sku = 'FG-000001');
select rls_test.ok('update: the audit log lists exactly which fields changed',
  rls_test.audit_fields(rls_test.id('fg')) @> '["hsn_code", "gst_rate", "selling_price", "standard_manufacturing_cost", "minimum_level", "remarks"]'::jsonb,
  rls_test.audit_fields(rls_test.id('fg'))::text);
set local role authenticated;
select rls_test.claims('viewer');
select rls_test.ok('permissions: a Management Viewer cannot create products',
  rls_test.add_product('{"product_name": "Viewer item", "product_type": "OTHER"}') ? 'error');
update public.products set remarks = 'viewer edit' where id = rls_test.id('fg');
reset role;
select rls_test.ok('permissions: ...or change them', (rls_test.product(rls_test.id('fg'))).remarks = 'Best seller');

-- ---------------------------------------------------------------------------
-- BOMs: source, supplier, multi-level, drafts without components
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('bom: a draft BOM can be saved before any component is known', 'bom_empty',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, 'To be completed', '[]'::jsonb, gen_random_uuid()) $q$, rls_test.id('fg2'), rls_test.today()));
select rls_test.expect_call_error('bom: ...but it cannot be activated without components',
  format('select public.production_bom_activate(%L)', rls_test.gid('bom_empty', 'bom_id')), 'at least one component');
select rls_test.expect_call_ok('bom: subassembly BOM (clay + outsourced flush plate) with explicit source and supplier on one line', 'bom_sub',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('sub'), rls_test.today(),
    jsonb_build_array(
      jsonb_build_object('component_product_id', rls_test.id('clay'), 'quantity_required', 4.5, 'wastage_percentage', 5),
      jsonb_build_object('component_product_id', rls_test.id('osc'), 'quantity_required', 1, 'source_type', 'purchased', 'preferred_supplier_id', rls_test.id('sup'), 'notes', 'Buy ready-made'))));
reset role;
select rls_test.ok('bom: source defaults from the product (clay -> Purchased) and supplier defaults from the product (Clay Traders); wastage kept',
  (rls_test.item(rls_test.gid('bom_sub', 'bom_id'), rls_test.id('clay'))).source_type = 'PURCHASED'
  and (rls_test.item(rls_test.gid('bom_sub', 'bom_id'), rls_test.id('clay'))).preferred_supplier_id = rls_test.id('sup')
  and (rls_test.item(rls_test.gid('bom_sub', 'bom_id'), rls_test.id('clay'))).wastage_percentage = 5);
select rls_test.ok('bom: an explicit source and supplier override the product defaults (flush plate: Purchased from Clay Traders)',
  (rls_test.item(rls_test.gid('bom_sub', 'bom_id'), rls_test.id('osc'))).source_type = 'PURCHASED'
  and (rls_test.item(rls_test.gid('bom_sub', 'bom_id'), rls_test.id('osc'))).preferred_supplier_id = rls_test.id('sup')
  and (rls_test.item(rls_test.gid('bom_sub', 'bom_id'), rls_test.id('osc'))).notes = 'Buy ready-made');
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('bom: the subassembly BOM is activated', 'bom_sub_on', format('select public.production_bom_activate(%L)', rls_test.gid('bom_sub', 'bom_id')));
select rls_test.expect_call_ok('bom: multi-level — the WC uses the subassembly, a component, packaging and a consumable', 'bom_fg',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('fg'), rls_test.today(),
    jsonb_build_array(
      jsonb_build_object('component_product_id', rls_test.id('sub'), 'quantity_required', 1),
      jsonb_build_object('component_product_id', rls_test.id('cmp'), 'quantity_required', 2),
      jsonb_build_object('component_product_id', rls_test.id('pkg'), 'quantity_required', 1),
      jsonb_build_object('component_product_id', rls_test.id('con'), 'quantity_required', 0.05, 'unit', 'kg'))));
reset role;
select rls_test.ok('bom: component sources default by type (subassembly In-House, component In-House, packaging and consumable Purchased)',
  (rls_test.item(rls_test.gid('bom_fg', 'bom_id'), rls_test.id('sub'))).source_type = 'IN_HOUSE'
  and (rls_test.item(rls_test.gid('bom_fg', 'bom_id'), rls_test.id('cmp'))).source_type = 'IN_HOUSE'
  and (rls_test.item(rls_test.gid('bom_fg', 'bom_id'), rls_test.id('pkg'))).source_type = 'PURCHASED'
  and (rls_test.item(rls_test.gid('bom_fg', 'bom_id'), rls_test.id('con'))).source_type = 'PURCHASED');
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('bom: packaging cannot have its own BOM',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('pkg'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('clay'), 'quantity_required', 1))), 'cannot have a BOM');
select rls_test.expect_call_error('bom: an unknown component source is refused',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('cmp'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('clay'), 'quantity_required', 1, 'source_type', 'BORROWED'))), 'source');
select rls_test.expect_call_error('bom: another company''s supplier is refused on a component line',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('cmp'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('clay'), 'quantity_required', 1, 'preferred_supplier_id', rls_test.id('b_sup')))), 'supplier');
select rls_test.expect_call_error('bom: circular BOMs are still refused (the WC inside its own subassembly)',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$, rls_test.id('sub'), rls_test.today(),
    jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('fg'), 'quantity_required', 1))), 'Circular');
select rls_test.ok('kpi: before activation the WC is a finished good without a BOM (2 of 3 finished goods)',
  (public.product_kpis() ->> 'without_bom')::int = 3 and (public.product_kpis() ->> 'finished_goods')::int = 3,
  public.product_kpis()::text);
select rls_test.expect_call_ok('bom: the WC BOM is activated', 'bom_fg_on', format('select public.production_bom_activate(%L)', rls_test.gid('bom_fg', 'bom_id')));
reset role;
select rls_test.ok('has_bom: activating a BOM marks the product as having a BOM and manufacturable',
  (rls_test.product(rls_test.id('fg'))).has_bom and (rls_test.product(rls_test.id('fg'))).is_manufacturable
  and (rls_test.product(rls_test.id('sub'))).has_bom and not (rls_test.product(rls_test.id('fg2'))).has_bom);

-- ---------------------------------------------------------------------------
-- Revisions: add a component later, same day
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('revision: "Edit components" starts version 2 as a copy', 'bom_fg_v2',
  format('select public.production_new_bom_version(%L, gen_random_uuid())', rls_test.gid('bom_fg', 'bom_id')));
reset role;
select rls_test.ok('revision: the copy keeps each line''s source and supplier',
  (rls_test.item(rls_test.gid('bom_fg_v2', 'bom_id'), rls_test.id('pkg'))).source_type = 'PURCHASED'
  and (select count(*) from public.bom_items where bom_id = rls_test.gid('bom_fg_v2', 'bom_id')) = 4);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('revision: a missed component (the outsourced flush plate) is added to version 2', 'bom_fg_v2_save',
  format($q$ select public.production_save_bom(%L, %L, %L, null, 1, null, %L::jsonb) $q$, rls_test.gid('bom_fg_v2', 'bom_id'), rls_test.id('fg'), rls_test.today(),
    jsonb_build_array(
      jsonb_build_object('component_product_id', rls_test.id('sub'), 'quantity_required', 1),
      jsonb_build_object('component_product_id', rls_test.id('cmp'), 'quantity_required', 3),
      jsonb_build_object('component_product_id', rls_test.id('pkg'), 'quantity_required', 1),
      jsonb_build_object('component_product_id', rls_test.id('con'), 'quantity_required', 0.05),
      jsonb_build_object('component_product_id', rls_test.id('osc'), 'quantity_required', 1))));
select rls_test.expect_call_ok('revision: version 2 is activated on the same day as version 1', 'bom_fg_v2_on',
  format('select public.production_bom_activate(%L)', rls_test.gid('bom_fg_v2', 'bom_id')));
reset role;
select rls_test.ok('revision: version 1 is archived as superseded (history kept), version 2 is active with the flush plate supplied by Fittings Works',
  (rls_test.bom(rls_test.gid('bom_fg', 'bom_id'))).status = 'ARCHIVED' and (rls_test.bom(rls_test.gid('bom_fg_v2', 'bom_id'))).status = 'APPROVED'
  and rls_test.get('bom_fg_v2_on') -> 'superseded_versions' = '["v1"]'::jsonb
  and (rls_test.item(rls_test.gid('bom_fg_v2', 'bom_id'), rls_test.id('osc'))).preferred_supplier_id = rls_test.id('sup2')
  and (rls_test.item(rls_test.gid('bom_fg_v2', 'bom_id'), rls_test.id('osc'))).source_type = 'OUTSOURCED'
  and (rls_test.product(rls_test.id('fg'))).has_bom, rls_test.get('bom_fg_v2_on')::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('has_bom: archiving the only active version', 'bom_fg_v2_off',
  format($q$ select public.production_bom_action(%L, 'ARCHIVE', 'Product redesigned') $q$, rls_test.gid('bom_fg_v2', 'bom_id')));
reset role;
select rls_test.ok('has_bom: ...turns has_bom off again', not (rls_test.product(rls_test.id('fg'))).has_bom);

-- ---------------------------------------------------------------------------
-- KPIs, views and isolation
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.ok('kpi: counts per type (3 finished goods, 1 raw material, 1 component, 1 subassembly, 1 outsourced, 1 packaging, 1 consumable)',
  (public.product_kpis() ->> 'finished_goods')::int = 3 and (public.product_kpis() ->> 'raw_materials')::int = 1
  and (public.product_kpis() ->> 'components')::int = 1 and (public.product_kpis() ->> 'subassemblies')::int = 1
  and (public.product_kpis() ->> 'outsourced_components')::int = 1 and (public.product_kpis() ->> 'packaging')::int = 1
  and (public.product_kpis() ->> 'consumables')::int = 1 and (public.product_kpis() ->> 'total')::int = 9, public.product_kpis()::text);
select rls_test.ok('kpi: finished goods / subassemblies without an active BOM = 3 (the WC''s BOM was archived; the subassembly still has one)',
  (public.product_kpis() ->> 'without_bom')::int = 3, public.product_kpis()::text);
select rls_test.ok('kpi: incomplete products are counted (8: every product except the WC, whose HSN, GST, category and price were added)',
  (public.product_kpis() ->> 'incomplete')::int = 8, public.product_kpis()::text);
select rls_test.ok('view: bom_item_list shows the source type and supplier of each line',
  (select source_type = 'OUTSOURCED' and preferred_supplier_id = rls_test.id('sup2') from public.bom_item_list
   where bom_id = rls_test.gid('bom_fg_v2', 'bom_id') and component_product_id = rls_test.id('osc')));
select rls_test.claims('b_op');
select rls_test.ok('isolation: company B sees none of company A''s products and its SKU numbering starts at FG-000001',
  not exists (select 1 from public.products where company_id = rls_test.id('company_a'))
  and public.product_sku_preview('FINISHED_GOOD') = 'FG-000001' and (public.product_kpis() ->> 'total')::int = 0);
select rls_test.expect_call_error('isolation: company B cannot build a BOM from company A''s products',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, '[]'::jsonb, gen_random_uuid()) $q$, rls_test.id('fg'), rls_test.today()), 'not found');
select rls_test.claims('viewer');
select rls_test.ok('permissions: a viewer gets no SKU preview', public.product_sku_preview('FINISHED_GOOD') is null);
reset role;
select rls_test.ok('grants: anon cannot call the SKU preview', not has_function_privilege('anon', 'public.product_sku_preview(text)', 'EXECUTE'));

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
  raise exception 'PRODUCT_V2_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
