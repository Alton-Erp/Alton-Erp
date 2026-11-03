-- =============================================================================
-- WHOLE-PIECE (PCS) QUANTITY VERIFICATION
--
-- Executable checks for migration 20261029090000_whole_piece_quantities.sql:
-- BOM policy, planning rounding (with wastage), production orders, reservations,
-- issue, output, outsourcing, purchasing, the stock ledger guard, detection and
-- reconciliation of historical fractions, dashboard totals vs the ledger, other
-- units unaffected, permissions and company isolation.
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction with its own companies (WPA / WPB) and users
-- (@wp.example.invalid) and ALWAYS ends by raising
--   WHOLE_PIECE_VERIFICATION_RESULT passed=N failed=M
-- so every test row (including the simulated legacy data) is rolled back.
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
-- Set-returning RPCs as a jsonb array (or {error}).
create function rls_test.rows(p_sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin execute format('select coalesce(jsonb_agg(to_jsonb(q)), ''[]''::jsonb) from (%s) q', p_sql) into r; return r;
exception when others then return jsonb_build_object('error', sqlerrm); end $$;
-- Requirement line of a planning result by SKU.
create function rls_test.req(p_rows jsonb, p_sku text) returns jsonb language sql immutable as $$
  select e from jsonb_array_elements(p_rows) e where e ->> 'sku' = p_sku limit 1 $$;

-- Owner-side probes (bypass RLS) used to assert stored state.
create function rls_test.on_hand(p_product uuid, p_location uuid default null) returns numeric
language sql stable security definer as $$
  select coalesce(sum(on_hand), 0) from public.inventory_balances where product_id = p_product and (p_location is null or location_id = p_location) $$;
create function rls_test.reserved(p_product uuid, p_location uuid default null) returns numeric
language sql stable security definer as $$
  select coalesce(sum(reserved), 0) from public.inventory_balances where product_id = p_product and (p_location is null or location_id = p_location) $$;
create function rls_test.ledger_count(p_company uuid) returns bigint
language sql stable security definer as $$ select count(*) from public.inventory_transactions where company_id = p_company $$;
create function rls_test.lot(p_product uuid) returns uuid
language sql stable security definer as $$ select id from public.inventory_batches where product_id = p_product and is_system_lot order by created_at limit 1 $$;
create function rls_test.material(p_order uuid, p_product uuid) returns public.production_order_materials
language sql stable security definer as $$ select * from public.production_order_materials where production_order_id = p_order and component_product_id = p_product $$;
create function rls_test.omaterial(p_order uuid, p_product uuid) returns public.outsourcing_order_materials
language sql stable security definer as $$ select * from public.outsourcing_order_materials where outsourcing_order_id = p_order and component_product_id = p_product $$;
create function rls_test.order_status(p_order uuid) returns text
language sql stable security definer as $$ select status from public.production_orders where id = p_order $$;
create function rls_test.open_res(p_order uuid) returns numeric
language sql stable security definer as $$
  select coalesce(sum(quantity - fulfilled_quantity - released_quantity), 0) from public.stock_reservations
  where reference_id = p_order and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') $$;
create function rls_test.today() returns date language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;
-- Audit finding rows of a category / classification.
create function rls_test.findings(p_audit jsonb, p_category text, p_class text default null) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(p_audit -> 'findings') e
  where e ->> 'category' = p_category and (p_class is null or e ->> 'classification' = p_class) $$;

grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures (database owner)
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5a900-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5a900-0000-4000-8000-0000000000b1'),
  ('pm',     'e7e5a900-0000-4000-8000-000000000002'),  -- Production Manager A (requester)
  ('pm2',    'e7e5a900-0000-4000-8000-000000000003'),  -- Production Manager A (approver)
  ('im',     'e7e5a900-0000-4000-8000-000000000004'),  -- Inventory Manager A (stores)
  ('adm',    'e7e5a900-0000-4000-8000-000000000005'),  -- Admin A
  ('pur',    'e7e5a900-0000-4000-8000-000000000006'),  -- Purchase Manager A
  ('viewer', 'e7e5a900-0000-4000-8000-000000000007'),  -- Management Viewer A
  ('b_im',   'e7e5a900-0000-4000-8000-000000000008'),  -- Inventory + Production Manager B
  ('ald',    'e7e5a900-0000-4000-8000-0000000000c1'), ('kit',  'e7e5a900-0000-4000-8000-0000000000c2'),
  ('tri',    'e7e5a900-0000-4000-8000-0000000000c3'), ('a1',   'e7e5a900-0000-4000-8000-0000000000c4'),
  ('a2',     'e7e5a900-0000-4000-8000-0000000000c5'), ('a3',   'e7e5a900-0000-4000-8000-0000000000c6'),
  ('clay',   'e7e5a900-0000-4000-8000-0000000000c7'), ('blank','e7e5a900-0000-4000-8000-0000000000c8'),
  ('leg',    'e7e5a900-0000-4000-8000-0000000000c9'), ('bolt', 'e7e5a900-0000-4000-8000-0000000000ca'),
  ('fix',    'e7e5a900-0000-4000-8000-0000000000cb'),
  ('b_a1',   'e7e5a900-0000-4000-8000-0000000000d1'),
  ('w1',     'e7e5a900-0000-4000-8000-0000000000e1'), ('wb',   'e7e5a900-0000-4000-8000-0000000000e2'),
  ('bin2',   'e7e5a900-0000-4000-8000-0000000000f1'), ('rej',  'e7e5a900-0000-4000-8000-0000000000f2'),
  ('ext',    'e7e5a900-0000-4000-8000-0000000000f3'),
  ('sup',    'e7e5a900-0000-4000-8000-0000000000f4');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code) values
  (rls_test.id('company_a'), 'Whole Piece Test A', 'Whole Piece Test A', 'WPA'),
  (rls_test.id('company_b'), 'Whole Piece Test B', 'Whole Piece Test B', 'WPB');
-- V2 turns segregation of duties off by default (single operator). This suite tests it, so it switches it on.
insert into public.company_settings (company_id, setting_key, setting_value)
select id, 'inventory.segregation_of_duties', 'true'::jsonb from public.companies where id in (rls_test.id('company_a'), rls_test.id('company_b'));

insert into auth.users (id, email)
select id, key || '@wp.example.invalid' from rls_test.ids where key in ('pm', 'pm2', 'im', 'adm', 'pur', 'viewer', 'b_im');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true
  where id in (rls_test.id('pm'), rls_test.id('pm2'), rls_test.id('im'), rls_test.id('adm'), rls_test.id('pur'), rls_test.id('viewer'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_im');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('pm'),     rls_test.id('company_a'), rls_test.id('role_production_manager')),
  (rls_test.id('pm2'),    rls_test.id('company_a'), rls_test.id('role_production_manager')),
  (rls_test.id('im'),     rls_test.id('company_a'), rls_test.id('role_inventory_manager')),
  (rls_test.id('adm'),    rls_test.id('company_a'), rls_test.id('role_admin')),
  (rls_test.id('pur'),    rls_test.id('company_a'), rls_test.id('role_purchase_manager')),
  (rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_management_viewer')),
  (rls_test.id('b_im'),   rls_test.id('company_b'), rls_test.id('role_inventory_manager')),
  (rls_test.id('b_im'),   rls_test.id('company_b'), rls_test.id('role_production_manager'));

insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, track_batches, track_expiry) values
  (rls_test.id('ald'),   rls_test.id('company_a'), 'ALD',   'ALD assembly',      'FINISHED_GOOD',      'IN_HOUSE',   'PCS', false, false),
  (rls_test.id('kit'),   rls_test.id('company_a'), 'KIT',   'Fitting kit',       'FINISHED_GOOD',      'IN_HOUSE',   'PCS', false, false),
  (rls_test.id('tri'),   rls_test.id('company_a'), 'TRI',   'Tri bracket',       'FINISHED_GOOD',      'IN_HOUSE',   'PCS', false, false),
  (rls_test.id('a1'),    rls_test.id('company_a'), 'A1',    'Extension',         'COMPONENT',          'OUTSOURCED', 'PCS', false, false),
  (rls_test.id('a2'),    rls_test.id('company_a'), 'A2',    'Washer',            'COMPONENT',          'OUTSOURCED', 'PCS', false, false),
  (rls_test.id('a3'),    rls_test.id('company_a'), 'A3',    'Plate',             'COMPONENT',          'OUTSOURCED', 'PCS', false, false),
  (rls_test.id('clay'),  rls_test.id('company_a'), 'CLAY',  'Ceramic body',      'RAW_MATERIAL',       'OUTSOURCED', 'KG',  false, false),
  (rls_test.id('blank'), rls_test.id('company_a'), 'BLANK', 'Processed blank',   'COMPONENT',          'HYBRID',     'PCS', false, false),
  (rls_test.id('leg'),   rls_test.id('company_a'), 'LEG',   'Bought-in leg',     'FINISHED_GOOD',      'OUTSOURCED', 'PCS', false, false),
  (rls_test.id('bolt'),  rls_test.id('company_a'), 'BOLT',  'Bolt',              'COMPONENT',          'OUTSOURCED', 'NOS', false, false),
  (rls_test.id('fix'),   rls_test.id('company_a'), 'FIX',   'Fixture (draft)',   'FINISHED_GOOD',      'IN_HOUSE',   'PCS', false, false),
  (rls_test.id('b_a1'),  rls_test.id('company_b'), 'A1',    'Company B part',    'COMPONENT',          'OUTSOURCED', 'PCS', false, false);

insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Plant store', true),
  (rls_test.id('wb'), rls_test.id('company_b'), 'W1', 'Company B store', true);
insert into public.inventory_locations (id, company_id, warehouse_id, location_code, location_name, location_type, stock_usage, external_holder) values
  (rls_test.id('bin2'), rls_test.id('company_a'), rls_test.id('w1'), 'BIN2', 'Second bin', 'AREA', 'STORAGE', null),
  (rls_test.id('rej'),  rls_test.id('company_a'), rls_test.id('w1'), 'REJECT', 'Rejected goods bay', 'AREA', 'REJECTED', null),
  (rls_test.id('ext'),  rls_test.id('company_a'), rls_test.id('w1'), 'JOB-WP', 'At job worker', 'AREA', 'EXTERNAL_PROCESSING', 'Job worker');
insert into rls_test.ids (key, id)
select case warehouse_id when rls_test.id('w1') then 'g1' else 'gb' end, id
from public.inventory_locations where location_code = 'GENERAL' and warehouse_id in (rls_test.id('w1'), rls_test.id('wb'));

insert into public.suppliers (id, company_id, supplier_code, legal_name, gstin, state_code, payment_terms, status) values
  (rls_test.id('sup'), rls_test.id('company_a'), 'S-WP', 'Fittings Supplier', '27AAPFU0939F1ZV', '27', 'DAYS_30', 'ACTIVE');

-- ===========================================================================
-- Schema / policy
-- ===========================================================================
select rls_test.ok('policy: PCS, NOS, SET and PAIR are whole-piece units; KG, M and L are not',
  private.is_whole_unit('PCS') and private.is_whole_unit('nos') and private.is_whole_unit('SET') and private.is_whole_unit('PAIR')
  and not private.is_whole_unit('KG') and not private.is_whole_unit('M') and not private.is_whole_unit('L'));
select rls_test.ok('policy: planned quantity rounds up to whole pieces only for whole-piece units (0.286 PCS -> 1; 0.2857 KG -> 0.286)',
  private.plan_qty(0.2857, 'PCS') = 1 and private.plan_qty(3, 'PCS') = 3 and private.plan_qty(0.2857, 'KG') = 0.286);
select rls_test.ok('schema: RLS still enabled on every public table',
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity));
select rls_test.ok('schema: whole-piece guards installed on the ledger and every production / outsourcing / purchasing quantity table',
  (select count(*) from pg_trigger where not tgisinternal and tgname like '%\_whole\_pieces') >= 15);
select rls_test.ok('schema: anon cannot run the audit; authenticated can (permission checked inside)',
  not has_function_privilege('anon', 'public.whole_unit_quantity_audit()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.whole_unit_quantity_audit()', 'EXECUTE'));

-- ===========================================================================
-- Stock ledger boundary (receipts, issues, transfers, reservations)
-- ===========================================================================
set local role authenticated;
select rls_test.claims('im');
select rls_test.expect_call_ok('setup: receive 100 PCS A1 (Extension)', 'r_a1',
  format($q$ select public.inventory_post_receipt(%L, %L, 100, 'OUTSOURCED', p_unit_cost => 12.5, p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('a1'), rls_test.id('g1')));
select rls_test.expect_call_ok('setup: receive 50 PCS A2 (Washer)', 'r_a2',
  format($q$ select public.inventory_post_receipt(%L, %L, 50, 'OUTSOURCED', p_unit_cost => 1.75, p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('a2'), rls_test.id('g1')));
select rls_test.expect_call_ok('setup: receive 50 PCS A3 (Plate)', 'r_a3',
  format($q$ select public.inventory_post_receipt(%L, %L, 50, 'OUTSOURCED', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('a3'), rls_test.id('g1')));
select rls_test.expect_call_ok('other units: a 100.5 KG clay receipt is still accepted', 'r_clay',
  format($q$ select public.inventory_post_receipt(%L, %L, 100.5, 'OUTSOURCED', p_unit_cost => 10.125, p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('clay'), rls_test.id('g1')));
reset role;
insert into rls_test.ids (key, id) values
  ('lot_a1', rls_test.lot(rls_test.id('a1'))), ('lot_a2', rls_test.lot(rls_test.id('a2'))),
  ('lot_a3', rls_test.lot(rls_test.id('a3'))), ('lot_clay', rls_test.lot(rls_test.id('clay')));
select rls_test.set('ledger_start', to_jsonb(rls_test.ledger_count(rls_test.id('company_a'))));

set local role authenticated;
select rls_test.claims('im');
select rls_test.expect_call_error('ledger: a receipt of 2.5 PCS is rejected',
  format($q$ select public.inventory_post_receipt(%L, %L, 2.5, 'OUTSOURCED', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('a1'), rls_test.id('g1')), 'whole');
select rls_test.expect_call_error('ledger: an issue of 1.5 PCS is rejected',
  format($q$ select public.inventory_post_issue(%L, %L, 1.5, p_reason => 'Workshop use', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('a1'), rls_test.id('g1')), 'whole');
select rls_test.expect_call_error('ledger: a transfer of 0.5 PCS is rejected',
  format($q$ select public.inventory_transfer_stock(%L, %L, %L, 0.5, p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('a1'), rls_test.id('g1'), rls_test.id('bin2')), 'whole');
select rls_test.expect_call_error('reservation: a reservation of 1.5 PCS is rejected',
  format($q$ select public.inventory_create_reservation(%L, %L, 1.5, 'TEST', 'T-1', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('a1'), rls_test.id('g1')), 'whole');
select rls_test.expect_call_error('ledger: NOS (alias of pieces) also rejects 1.5',
  format($q$ select public.inventory_post_receipt(%L, %L, 1.5, 'OUTSOURCED', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('bolt'), rls_test.id('g1')), 'whole');
select rls_test.expect_call_error('adjustment: a counted quantity of 99.5 PCS is rejected',
  format($q$ select public.inventory_create_adjustment('QUANTITY', %L, %L, 'COUNT_VARIANCE', p_batch_id => %L, p_counted_quantity => 99.5, p_notes => 'Count', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.id('a1'), rls_test.id('g1'), rls_test.id('lot_a1')), 'whole');
select rls_test.expect_call_ok('other units: transfer 0.25 KG clay still allowed', 'clay_tr',
  format($q$ select public.inventory_transfer_stock(%L, %L, %L, 0.25, p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('clay'), rls_test.id('g1'), rls_test.id('bin2')));
select rls_test.expect_call_ok('ledger: whole quantities post normally (transfer 3 PCS A1)', 'a1_tr',
  format($q$ select public.inventory_transfer_stock(%L, %L, %L, 3, p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('a1'), rls_test.id('g1'), rls_test.id('bin2')));
select rls_test.call(format($q$ select public.inventory_transfer_stock(%L, %L, %L, 3, p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('a1'), rls_test.id('bin2'), rls_test.id('g1')));
reset role;
select rls_test.ok('ledger: rejected requests posted nothing (A1 100, clay 100.5; only the 2 clay and 4 A1 transfer legs added)',
  rls_test.on_hand(rls_test.id('a1')) = 100 and rls_test.on_hand(rls_test.id('a1'), rls_test.id('g1')) = 100
  and rls_test.on_hand(rls_test.id('clay')) = 100.5 and rls_test.on_hand(rls_test.id('clay'), rls_test.id('bin2')) = 0.25
  and rls_test.ledger_count(rls_test.id('company_a')) = (rls_test.get('ledger_start'))::bigint + 6);

-- ===========================================================================
-- BOM policy: whole pieces per BOM batch; ratios kept
-- ===========================================================================
set local role authenticated;
select rls_test.claims('pm');
select rls_test.expect_call_ok('bom: ALD BOM saved as "2 A1, 1 A2, 1 A3 per 70 ALD" (the reported ratio)', 'bom_ald',
  format($q$ select public.production_save_bom(null, %L, %L, null, 70, 'Shared parts per batch', %L::jsonb, gen_random_uuid()) $q$,
    rls_test.id('ald'), rls_test.today(), jsonb_build_array(
      jsonb_build_object('component_product_id', rls_test.id('a1'), 'quantity_required', 2),
      jsonb_build_object('component_product_id', rls_test.id('a2'), 'quantity_required', 1),
      jsonb_build_object('component_product_id', rls_test.id('a3'), 'quantity_required', 1))));
select rls_test.call(format($q$ select public.production_bom_action(%L, 'SUBMIT') $q$, rls_test.gid('bom_ald', 'bom_id')));
select rls_test.claims('pm2');
select rls_test.expect_call_ok('bom: ALD BOM approved by a second manager', 'bom_ald_ok',
  format($q$ select public.production_bom_action(%L, 'APPROVE') $q$, rls_test.gid('bom_ald', 'bom_id')));

select rls_test.claims('pm');
select rls_test.expect_call_ok('bom: a draft with 0.5 PCS per unit can be saved while it is being corrected', 'bom_kit',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$,
    rls_test.id('kit'), rls_test.today(), jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('a1'), 'quantity_required', 0.5))));
select rls_test.expect_call_error('bom: ... but cannot be submitted (component quantity must be whole pieces per batch)',
  format($q$ select public.production_bom_action(%L, 'SUBMIT') $q$, rls_test.gid('bom_kit', 'bom_id')), 'not a whole number');
select rls_test.expect_call_ok('bom: corrected kit BOM per 10 kits: A1 10 (+5%), A2 9 (+10%), clay 2.5 KG (+10%)', 'bom_kit_fix',
  format($q$ select public.production_save_bom(%L, %L, %L, null, 10, null, %L::jsonb) $q$,
    rls_test.gid('bom_kit', 'bom_id'), rls_test.id('kit'), rls_test.today(), jsonb_build_array(
      jsonb_build_object('component_product_id', rls_test.id('a1'), 'quantity_required', 10, 'wastage_percentage', 5),
      jsonb_build_object('component_product_id', rls_test.id('a2'), 'quantity_required', 9, 'wastage_percentage', 10),
      jsonb_build_object('component_product_id', rls_test.id('clay'), 'quantity_required', 2.5, 'wastage_percentage', 10))));
select rls_test.expect_call_ok('bom: corrected kit BOM submits', 'bom_kit_sub', format($q$ select public.production_bom_action(%L, 'SUBMIT') $q$, rls_test.gid('bom_kit', 'bom_id')));
select rls_test.expect_call_ok('bom: TRI draft with a 2.5 PCS output saved', 'bom_tri',
  format($q$ select public.production_save_bom(null, %L, %L, null, 2.5, null, %L::jsonb, gen_random_uuid()) $q$,
    rls_test.id('tri'), rls_test.today(), jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('a3'), 'quantity_required', 2))));
select rls_test.expect_call_error('bom: a fractional PCS output quantity cannot be submitted',
  format($q$ select public.production_bom_action(%L, 'SUBMIT') $q$, rls_test.gid('bom_tri', 'bom_id')), 'output quantity');
select rls_test.call(format($q$ select public.production_save_bom(%L, %L, %L, null, 3, null, %L::jsonb) $q$,
  rls_test.gid('bom_tri', 'bom_id'), rls_test.id('tri'), rls_test.today(), jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('a3'), 'quantity_required', 2))));
select rls_test.call(format($q$ select public.production_bom_action(%L, 'SUBMIT') $q$, rls_test.gid('bom_tri', 'bom_id')));
select rls_test.expect_call_ok('bom: FIX draft left with 0.5 PCS (for the audit)', 'bom_fix',
  format($q$ select public.production_save_bom(null, %L, %L, null, 1, null, %L::jsonb, gen_random_uuid()) $q$,
    rls_test.id('fix'), rls_test.today(), jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('a2'), 'quantity_required', 0.5))));
select rls_test.claims('pm2');
select rls_test.call(format($q$ select public.production_bom_action(%L, 'APPROVE') $q$, rls_test.gid('bom_kit', 'bom_id')));
select rls_test.call(format($q$ select public.production_bom_action(%L, 'APPROVE') $q$, rls_test.gid('bom_tri', 'bom_id')));
reset role;
select rls_test.ok('bom: kit and tri BOMs approved',
  (select bool_and(status = 'APPROVED') from public.boms where id in (rls_test.gid('bom_kit', 'bom_id'), rls_test.gid('bom_tri', 'bom_id'))));

-- ===========================================================================
-- Material requirements (planning)
-- ===========================================================================
set local role authenticated;
select rls_test.claims('pm');
select rls_test.set('plan10', rls_test.rows(format('select * from public.production_bom_requirements(%L, 10)', rls_test.gid('bom_ald', 'bom_id'))));
select rls_test.ok('planning (ALD x 10): A1 planned 1 PCS, theoretical 0.286 shown separately',
  (rls_test.req(rls_test.get('plan10'), 'A1') ->> 'total_requirement')::numeric = 1
  and (rls_test.req(rls_test.get('plan10'), 'A1') ->> 'base_requirement')::numeric = 0.286, rls_test.get('plan10')::text);
select rls_test.ok('planning (ALD x 10): A2 and A3 planned 1 PCS each (theoretical 0.143)',
  (rls_test.req(rls_test.get('plan10'), 'A2') ->> 'total_requirement')::numeric = 1
  and (rls_test.req(rls_test.get('plan10'), 'A3') ->> 'total_requirement')::numeric = 1
  and (rls_test.req(rls_test.get('plan10'), 'A2') ->> 'base_requirement')::numeric = 0.143);
select rls_test.ok('planning: every planned, shortage and suggested quantity of a PCS item is whole',
  (select bool_and((e ->> 'total_requirement')::numeric = trunc((e ->> 'total_requirement')::numeric)
                   and (e ->> 'shortage')::numeric = trunc((e ->> 'shortage')::numeric)
                   and (e ->> 'suggested_quantity')::numeric = trunc((e ->> 'suggested_quantity')::numeric))
   from jsonb_array_elements(rls_test.get('plan10')) e));
select rls_test.expect_call_error('planning: a fractional ALD quantity (10.5 PCS) is rejected',
  format('select count(*) from public.production_bom_requirements(%L, 10.5)', rls_test.gid('bom_ald', 'bom_id')), 'whole number');

select rls_test.set('plan35',  rls_test.rows(format('select * from public.production_bom_requirements(%L, 35)',  rls_test.gid('bom_ald', 'bom_id'))));
select rls_test.set('plan70',  rls_test.rows(format('select * from public.production_bom_requirements(%L, 70)',  rls_test.gid('bom_ald', 'bom_id'))));
select rls_test.set('plan71',  rls_test.rows(format('select * from public.production_bom_requirements(%L, 71)',  rls_test.gid('bom_ald', 'bom_id'))));
select rls_test.set('plan140', rls_test.rows(format('select * from public.production_bom_requirements(%L, 140)', rls_test.gid('bom_ald', 'bom_id'))));
select rls_test.ok('multiples: 35 ALD -> A1 1 (exactly 1.0), A2 1 (0.5 rounded up)',
  (rls_test.req(rls_test.get('plan35'), 'A1') ->> 'total_requirement')::numeric = 1 and (rls_test.req(rls_test.get('plan35'), 'A2') ->> 'total_requirement')::numeric = 1);
select rls_test.ok('multiples: 70 ALD -> A1 2, A2 1, A3 1 (exact batch)',
  (rls_test.req(rls_test.get('plan70'), 'A1') ->> 'total_requirement')::numeric = 2 and (rls_test.req(rls_test.get('plan70'), 'A2') ->> 'total_requirement')::numeric = 1
  and (rls_test.req(rls_test.get('plan70'), 'A3') ->> 'total_requirement')::numeric = 1);
select rls_test.ok('multiples: 71 ALD -> A1 3 (2.029 up), A2 2 (1.014 up)',
  (rls_test.req(rls_test.get('plan71'), 'A1') ->> 'total_requirement')::numeric = 3 and (rls_test.req(rls_test.get('plan71'), 'A2') ->> 'total_requirement')::numeric = 2);
select rls_test.ok('multiples: 140 ALD -> A1 4, A2 2',
  (rls_test.req(rls_test.get('plan140'), 'A1') ->> 'total_requirement')::numeric = 4 and (rls_test.req(rls_test.get('plan140'), 'A2') ->> 'total_requirement')::numeric = 2);

select rls_test.set('kit1',  rls_test.rows(format('select * from public.production_bom_requirements(%L, 1)',  rls_test.gid('bom_kit', 'bom_id'))));
select rls_test.set('kit10', rls_test.rows(format('select * from public.production_bom_requirements(%L, 10)', rls_test.gid('bom_kit', 'bom_id'))));
select rls_test.set('kit20', rls_test.rows(format('select * from public.production_bom_requirements(%L, 20)', rls_test.gid('bom_kit', 'bom_id'))));
select rls_test.ok('wastage: 1 kit -> A1 1 x 1.05 = 1.05 -> 2 PCS',
  (rls_test.req(rls_test.get('kit1'), 'A1') ->> 'total_requirement')::numeric = 2);
select rls_test.ok('wastage is applied BEFORE rounding: 1 kit -> A2 0.9 x 1.10 = 0.99 -> 1 PCS (not ceil(0.9) x 1.1 -> 2)',
  (rls_test.req(rls_test.get('kit1'), 'A2') ->> 'total_requirement')::numeric = 1
  and (rls_test.req(rls_test.get('kit1'), 'A2') ->> 'base_requirement')::numeric = 0.9
  and (rls_test.req(rls_test.get('kit1'), 'A2') ->> 'wastage_allowance')::numeric = 0.09);
select rls_test.ok('wastage: 10 kits -> A1 10.5 -> 11, A2 9.9 -> 10; 20 kits -> A1 exactly 21, A2 19.8 -> 20',
  (rls_test.req(rls_test.get('kit10'), 'A1') ->> 'total_requirement')::numeric = 11 and (rls_test.req(rls_test.get('kit10'), 'A2') ->> 'total_requirement')::numeric = 10
  and (rls_test.req(rls_test.get('kit20'), 'A1') ->> 'total_requirement')::numeric = 21 and (rls_test.req(rls_test.get('kit20'), 'A2') ->> 'total_requirement')::numeric = 20);
select rls_test.ok('other units: clay keeps 3 decimals (1 kit 0.275 KG, 10 kits 2.75 KG; not rounded to whole)',
  (rls_test.req(rls_test.get('kit1'), 'CLAY') ->> 'total_requirement')::numeric = 0.275
  and (rls_test.req(rls_test.get('kit10'), 'CLAY') ->> 'total_requirement')::numeric = 2.75);
select rls_test.set('tri3', rls_test.rows(format('select * from public.production_bom_requirements(%L, 3)', rls_test.gid('bom_tri', 'bom_id'))));
select rls_test.set('tri4', rls_test.rows(format('select * from public.production_bom_requirements(%L, 4)', rls_test.gid('bom_tri', 'bom_id'))));
select rls_test.ok('exact arithmetic: 2 per 3 units -> 3 TRI need exactly 2 A3 (no 2.000001 -> 3), 4 TRI need 3',
  (rls_test.req(rls_test.get('tri3'), 'A3') ->> 'total_requirement')::numeric = 2 and (rls_test.req(rls_test.get('tri4'), 'A3') ->> 'total_requirement')::numeric = 3);
select rls_test.set('plan7000', rls_test.rows(format('select * from public.production_bom_requirements(%L, 7000, %L)', rls_test.gid('bom_ald', 'bom_id'), rls_test.id('w1'))));
select rls_test.ok('insufficient stock: 7000 ALD need 200 A1, 100 available -> shortage 100, PARTIAL',
  (rls_test.req(rls_test.get('plan7000'), 'A1') ->> 'total_requirement')::numeric = 200
  and (rls_test.req(rls_test.get('plan7000'), 'A1') ->> 'shortage')::numeric = 100
  and rls_test.req(rls_test.get('plan7000'), 'A1') ->> 'line_status' = 'PARTIAL');

-- ===========================================================================
-- Production orders: quantity, plan snapshot, reservations, issue, output
-- ===========================================================================
select rls_test.expect_call_error('order: a production order for 10.5 PCS is rejected',
  format($q$ select public.production_save_order(null, %L, 10.5, %L, %L, %L, %L, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('bom_ald', 'bom_id'), rls_test.id('w1'), rls_test.id('w1'), rls_test.today(), rls_test.today() + 5), 'whole');
select rls_test.expect_call_ok('order: production order for 10 ALD created', 'p_ald',
  format($q$ select public.production_save_order(null, %L, 10, %L, %L, %L, %L, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('bom_ald', 'bom_id'), rls_test.id('w1'), rls_test.id('w1'), rls_test.today(), rls_test.today() + 5));
reset role;
select rls_test.ok('order: material plan snapshot is whole (A1 1, A2 1, A3 1) with the theoretical 0.286 / 0.143 kept as base quantity',
  (rls_test.material(rls_test.gid('p_ald', 'order_id'), rls_test.id('a1'))).planned_quantity = 1
  and (rls_test.material(rls_test.gid('p_ald', 'order_id'), rls_test.id('a2'))).planned_quantity = 1
  and (rls_test.material(rls_test.gid('p_ald', 'order_id'), rls_test.id('a3'))).planned_quantity = 1
  and (rls_test.material(rls_test.gid('p_ald', 'order_id'), rls_test.id('a1'))).base_quantity = 0.286
  and (rls_test.material(rls_test.gid('p_ald', 'order_id'), rls_test.id('a2'))).base_quantity = 0.143);
set local role authenticated;
select rls_test.call(format($q$ select public.production_order_action(%L, 'SUBMIT') $q$, rls_test.gid('p_ald', 'order_id')));
select rls_test.claims('pm2');
select rls_test.call(format($q$ select public.production_order_action(%L, 'APPROVE') $q$, rls_test.gid('p_ald', 'order_id')));
select rls_test.claims('pm');
select rls_test.expect_call_ok('reserve: materials for 10 ALD reserved', 'res1',
  format($q$ select public.production_reserve_materials(%L, false, gen_random_uuid()) $q$, rls_test.gid('p_ald', 'order_id')));
reset role;
select rls_test.ok('reserve: 1 PCS reserved per component; available = on hand - reserved (A1 100 - 1 = 99)',
  rls_test.reserved(rls_test.id('a1')) = 1 and rls_test.reserved(rls_test.id('a2')) = 1 and rls_test.reserved(rls_test.id('a3')) = 1
  and (select available from public.inventory_product_stock where product_id = rls_test.id('a1')) = 99
  and rls_test.open_res(rls_test.gid('p_ald', 'order_id')) = 3);
set local role authenticated;
select rls_test.claims('pm');
select rls_test.expect_call_ok('release: reservations released', 'rel1',
  format($q$ select public.production_release_reservations(%L, 'Re-plan') $q$, rls_test.gid('p_ald', 'order_id')));
select rls_test.ok('release: 3 PCS released, nothing reserved, available back to 100',
  (rls_test.get('rel1') ->> 'released_quantity')::numeric = 3 and rls_test.reserved(rls_test.id('a1')) = 0);
select rls_test.call(format($q$ select public.production_reserve_materials(%L, false, gen_random_uuid()) $q$, rls_test.gid('p_ald', 'order_id')));
select rls_test.expect_call_error('reserve: reserving again reserves nothing more (no over-reservation)',
  format($q$ select public.production_reserve_materials(%L, false, gen_random_uuid()) $q$, rls_test.gid('p_ald', 'order_id')), 'already reserved');

-- Insufficient stock
select rls_test.expect_call_ok('insufficient: order for 7000 ALD created (needs 200 A1)', 'p_big',
  format($q$ select public.production_save_order(null, %L, 7000, %L, %L, %L, %L, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('bom_ald', 'bom_id'), rls_test.id('w1'), rls_test.id('w1'), rls_test.today(), rls_test.today() + 30));
select rls_test.call(format($q$ select public.production_order_action(%L, 'SUBMIT') $q$, rls_test.gid('p_big', 'order_id')));
select rls_test.claims('pm2');
select rls_test.call(format($q$ select public.production_order_action(%L, 'APPROVE') $q$, rls_test.gid('p_big', 'order_id')));
select rls_test.claims('pm');
select rls_test.expect_call_error('insufficient: all-or-nothing reservation refused with the whole-piece shortage (A1 short by 101)',
  format($q$ select public.production_reserve_materials(%L, false, gen_random_uuid()) $q$, rls_test.gid('p_big', 'order_id')), 'A1 short by 101 PCS');
select rls_test.ok('insufficient: nothing was reserved by the refused request', rls_test.open_res(rls_test.gid('p_big', 'order_id')) = 0 and rls_test.reserved(rls_test.id('a1')) = 1);
select rls_test.expect_call_ok('insufficient: a partial reservation takes the 99 available pieces', 'res_big',
  format($q$ select public.production_reserve_materials(%L, true, gen_random_uuid()) $q$, rls_test.gid('p_big', 'order_id')));
select rls_test.ok('insufficient: partial reservation is whole (A1 99 of 200) and stock is fully reserved, never over-reserved',
  rls_test.open_res(rls_test.gid('p_big', 'order_id')) = 99 + 49 + 49 and rls_test.reserved(rls_test.id('a1')) = 100 and rls_test.on_hand(rls_test.id('a1')) = 100);
select rls_test.call(format($q$ select public.production_release_reservations(%L, 'Not now') $q$, rls_test.gid('p_big', 'order_id')));

-- Start, issue, output, complete
select rls_test.call(format($q$ select public.production_order_action(%L, 'START') $q$, rls_test.gid('p_ald', 'order_id')));
select rls_test.claims('im');
select rls_test.expect_call_error('issue: issuing 0.5 PCS of A1 is rejected',
  format($q$ select public.production_issue_materials(%L, %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('p_ald', 'order_id'),
    jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.material(rls_test.gid('p_ald', 'order_id'), rls_test.id('a1'))).id,
      'batch_id', rls_test.id('lot_a1'), 'location_id', rls_test.id('g1'), 'quantity', 0.5))), 'whole');
select rls_test.expect_call_ok('issue: 1 PCS each of A1, A2, A3 issued (consumes the reservations)', 'iss1',
  format($q$ select public.production_issue_materials(%L, %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('p_ald', 'order_id'),
    (select jsonb_agg(jsonb_build_object('order_material_id', (rls_test.material(rls_test.gid('p_ald', 'order_id'), x.p)).id,
      'batch_id', x.lot, 'location_id', rls_test.id('g1'), 'quantity', 1))
     from (values (rls_test.id('a1'), rls_test.id('lot_a1')), (rls_test.id('a2'), rls_test.id('lot_a2')), (rls_test.id('a3'), rls_test.id('lot_a3'))) x(p, lot))));
reset role;
select rls_test.ok('issue: A1 99 on hand, nothing reserved; issued quantities whole',
  rls_test.on_hand(rls_test.id('a1')) = 99 and rls_test.reserved(rls_test.id('a1')) = 0
  and (rls_test.material(rls_test.gid('p_ald', 'order_id'), rls_test.id('a1'))).issued_quantity = 1);
set local role authenticated;
select rls_test.claims('pm');
select rls_test.expect_call_error('output: receiving 9.5 good ALD is rejected',
  format($q$ select public.production_receive_output(%L, 9.5, p_good_location_id => %L, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('p_ald', 'order_id'), rls_test.id('g1')), 'whole');
select rls_test.expect_call_error('output: 0.5 rejected ALD is rejected too',
  format($q$ select public.production_receive_output(%L, 9, 0.5, p_good_location_id => %L, p_rejection_reason => 'Crack', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('p_ald', 'order_id'), rls_test.id('g1')), 'whole');
select rls_test.expect_call_ok('output: 9 good + 1 rejected (recorded, not stocked) ALD received', 'out1',
  format($q$ select public.production_receive_output(%L, 9, 1, p_good_location_id => %L, p_rejection_reason => 'Crack', p_unit_cost => 125.375, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('p_ald', 'order_id'), rls_test.id('g1')));
select rls_test.expect_call_ok('complete: order completes with no discrepancy (whole standard 1 PCS per component for 10 ALD)', 'cmp1',
  format($q$ select public.production_order_action(%L, 'COMPLETE') $q$, rls_test.gid('p_ald', 'order_id')));
reset role;
select rls_test.ok('output: 9 ALD in stock, order COMPLETED with no discrepancies; unit cost keeps its 4 decimals',
  rls_test.on_hand(rls_test.id('ald')) = 9 and rls_test.order_status(rls_test.gid('p_ald', 'order_id')) = 'COMPLETED'
  and jsonb_array_length(rls_test.get('cmp1') -> 'discrepancies') = 0
  and (select unit_cost from public.production_output_receipts where production_order_id = rls_test.gid('p_ald', 'order_id')) = 125.375);

-- ===========================================================================
-- Outsourcing: ordered, dispatched, received, accepted, rejected, consumed
-- ===========================================================================
set local role authenticated;
select rls_test.claims('pur');
select rls_test.expect_call_error('outsourcing: ordering 4.5 PCS is rejected',
  format($q$ select public.outsourcing_save_order(null, 'OUTSOURCED_PROCESSING', %L, null, 4.5, 'Job worker', null, %L, %L, %L, p_materials => %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.id('blank'), rls_test.today() + 10, rls_test.id('w1'), rls_test.id('ext'), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('a2'), 'quantity', 10))), 'whole');
select rls_test.expect_call_error('outsourcing: a 2.5 PCS material line is rejected',
  format($q$ select public.outsourcing_save_order(null, 'OUTSOURCED_PROCESSING', %L, null, 10, 'Job worker', null, %L, %L, %L, p_materials => %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.id('blank'), rls_test.today() + 10, rls_test.id('w1'), rls_test.id('ext'), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('a2'), 'quantity', 2.5))), 'whole');
select rls_test.expect_call_ok('outsourcing: processing order for 10 blanks from 10 PCS A2 + 5.5 KG clay', 'o1',
  format($q$ select public.outsourcing_save_order(null, 'OUTSOURCED_PROCESSING', %L, null, 10, 'Job worker', null, %L, %L, %L, p_materials => %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.id('blank'), rls_test.today() + 10, rls_test.id('w1'), rls_test.id('ext'), jsonb_build_array(
      jsonb_build_object('product_id', rls_test.id('a2'), 'quantity', 10), jsonb_build_object('product_id', rls_test.id('clay'), 'quantity', 5.5))));
select rls_test.expect_call_error('outsourcing: a bought-in order for 3.5 PCS is rejected',
  format($q$ select public.outsourcing_save_order(null, 'OUTSOURCED_FINISHED_GOODS', %L, null, 3.5, 'Leg maker', null, %L, %L, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.id('leg'), rls_test.today() + 10, rls_test.id('w1')), 'whole');
select rls_test.call(format($q$ select public.outsourcing_order_action(%L, 'SUBMIT') $q$, rls_test.gid('o1', 'order_id')));
select rls_test.claims('adm');
select rls_test.call(format($q$ select public.outsourcing_order_action(%L, 'APPROVE') $q$, rls_test.gid('o1', 'order_id')));
select rls_test.claims('im');
select rls_test.expect_call_error('dispatch: sending 2.5 PCS A2 to the job worker is rejected',
  format($q$ select public.outsourcing_move_materials(%L, 'DISPATCH', %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('o1', 'order_id'),
    jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.omaterial(rls_test.gid('o1', 'order_id'), rls_test.id('a2'))).id,
      'batch_id', rls_test.id('lot_a2'), 'location_id', rls_test.id('g1'), 'quantity', 2.5))), 'whole');
select rls_test.expect_call_ok('dispatch: 10 PCS A2 and 5.5 KG clay dispatched', 'disp1',
  format($q$ select public.outsourcing_move_materials(%L, 'DISPATCH', %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('o1', 'order_id'),
    jsonb_build_array(
      jsonb_build_object('order_material_id', (rls_test.omaterial(rls_test.gid('o1', 'order_id'), rls_test.id('a2'))).id, 'batch_id', rls_test.id('lot_a2'), 'location_id', rls_test.id('g1'), 'quantity', 10),
      jsonb_build_object('order_material_id', (rls_test.omaterial(rls_test.gid('o1', 'order_id'), rls_test.id('clay'))).id, 'batch_id', rls_test.id('lot_clay'), 'location_id', rls_test.id('g1'), 'quantity', 5.5))));
select rls_test.expect_call_error('receipt: receiving 4.5 blanks is rejected',
  format($q$ select public.outsourcing_receive_goods(%L, 4.5, 4.5, 0, %L, p_consumption => %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('o1', 'order_id'), rls_test.id('g1'),
    jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.omaterial(rls_test.gid('o1', 'order_id'), rls_test.id('a2'))).id, 'batch_id', rls_test.id('lot_a2'), 'quantity', 4))), 'whole');
select rls_test.expect_call_error('receipt: accepted 7.5 / rejected 2.5 is rejected',
  format($q$ select public.outsourcing_receive_goods(%L, 10, 7.5, 2.5, %L, p_rejection_disposition => 'RETURN_TO_SUPPLIER', p_rejection_reason => 'Burrs', p_consumption => %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('o1', 'order_id'), rls_test.id('g1'),
    jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.omaterial(rls_test.gid('o1', 'order_id'), rls_test.id('a2'))).id, 'batch_id', rls_test.id('lot_a2'), 'quantity', 10))), 'whole');
select rls_test.expect_call_error('receipt: consuming 9.5 PCS of supplier-held A2 is rejected',
  format($q$ select public.outsourcing_receive_goods(%L, 10, 8, 2, %L, p_rejection_disposition => 'RETURN_TO_SUPPLIER', p_rejection_reason => 'Burrs', p_consumption => %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('o1', 'order_id'), rls_test.id('g1'),
    jsonb_build_array(jsonb_build_object('order_material_id', (rls_test.omaterial(rls_test.gid('o1', 'order_id'), rls_test.id('a2'))).id, 'batch_id', rls_test.id('lot_a2'), 'quantity', 9.5))), 'whole');
select rls_test.expect_call_ok('receipt: 10 received = 8 accepted + 2 rejected; 10 PCS A2 and 5.5 KG clay consumed', 'orc1',
  format($q$ select public.outsourcing_receive_goods(%L, 10, 8, 2, %L, p_rejection_disposition => 'RETURN_TO_SUPPLIER', p_rejection_reason => 'Burrs', p_consumption => %L::jsonb, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('o1', 'order_id'), rls_test.id('g1'),
    jsonb_build_array(
      jsonb_build_object('order_material_id', (rls_test.omaterial(rls_test.gid('o1', 'order_id'), rls_test.id('a2'))).id, 'batch_id', rls_test.id('lot_a2'), 'quantity', 10),
      jsonb_build_object('order_material_id', (rls_test.omaterial(rls_test.gid('o1', 'order_id'), rls_test.id('clay'))).id, 'batch_id', rls_test.id('lot_clay'), 'quantity', 5.5))));
reset role;
select rls_test.ok('outsourcing: 8 blanks in stock, order 10 received / 8 accepted / 2 rejected, nothing left at the job worker',
  rls_test.on_hand(rls_test.id('blank')) = 8
  and (select received_quantity = 10 and accepted_quantity = 8 and rejected_quantity = 2 from public.outsourcing_orders where id = rls_test.gid('o1', 'order_id'))
  and rls_test.on_hand(rls_test.id('a2'), rls_test.id('ext')) = 0 and rls_test.on_hand(rls_test.id('clay'), rls_test.id('ext')) = 0);

-- ===========================================================================
-- Purchasing (the ledger rule would otherwise leave fractional PO lines unreceivable)
-- ===========================================================================
set local role authenticated;
select rls_test.claims('pur');
select rls_test.expect_call_error('purchase order: a 2.5 PCS goods line is rejected with its line number',
  format('select public.purchase_order_save(null, %L::jsonb, %L::jsonb, null, %L)',
    jsonb_build_object('supplier_id', rls_test.id('sup'), 'purchase_type', 'RAW_MATERIAL', 'warehouse_id', rls_test.id('w1'), 'expected_delivery_date', (current_date + 7)::text),
    jsonb_build_array(jsonb_build_object('line_type', 'GOODS', 'product_id', rls_test.id('a1'), 'quantity', '2.5', 'unit_price', 12.5)), gen_random_uuid()), 'Line 1: A1');
select rls_test.expect_call_ok('purchase order: 3 PCS A1 + 2.5 KG clay + a 1.5-hour service line accepted', 'po1',
  format('select public.purchase_order_save(null, %L::jsonb, %L::jsonb, null, %L)',
    jsonb_build_object('supplier_id', rls_test.id('sup'), 'purchase_type', 'RAW_MATERIAL', 'warehouse_id', rls_test.id('w1'), 'expected_delivery_date', (current_date + 7)::text),
    jsonb_build_array(
      jsonb_build_object('line_type', 'GOODS', 'product_id', rls_test.id('a1'), 'quantity', 3, 'unit_price', '12.3456'),
      jsonb_build_object('line_type', 'GOODS', 'product_id', rls_test.id('clay'), 'quantity', '2.5', 'unit_price', 10),
      jsonb_build_object('line_type', 'SERVICE', 'description', 'Inspection', 'unit', 'HRS', 'quantity', '1.5', 'unit_price', 400, 'gst_rate', 18, 'hsn_sac', '998346')),
    gen_random_uuid()));
reset role;
select rls_test.ok('purchase order: currency keeps its precision (3 x 12.3456 = 37.04 taxable, not rounded because of PCS)',
  (select taxable_value from public.purchase_order_lines where purchase_order_id = rls_test.gid('po1', 'po_id') and product_id = rls_test.id('a1')) = 37.04);

-- ===========================================================================
-- Historical fractional data: detection, blocking, reconciliation
-- (simulated legacy rows written as the database owner with the guards off)
-- ===========================================================================
alter table public.inventory_transactions disable trigger inventory_transactions_whole_pieces;
select rls_test.set('legacy_rcpt', to_jsonb(private.post_movement(rls_test.id('company_a'), 'RECEIPT', rls_test.id('lot_a1'), rls_test.id('bin2'), 78.571, null,
  'LEGACY', 'OLD-1', null, 'Legacy fractional receipt', null, now(), 'RECEIPT', null)));
select rls_test.set('legacy_issue', to_jsonb(private.post_movement(rls_test.id('company_a'), 'ISSUE', rls_test.id('lot_a3'), rls_test.id('g1'), 0.286, null,
  'LEGACY', 'OLD-2', null, 'Legacy fractional issue', null, now(), 'ISSUE', null)));
alter table public.inventory_transactions enable trigger inventory_transactions_whole_pieces;

set local role authenticated;
select rls_test.claims('pm');
select rls_test.expect_call_ok('legacy: a second ALD order (to be given a pre-fix fractional plan)', 'p_old',
  format($q$ select public.production_save_order(null, %L, 10, %L, %L, %L, %L, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('bom_ald', 'bom_id'), rls_test.id('w1'), rls_test.id('w1'), rls_test.today(), rls_test.today() + 5));
select rls_test.call(format($q$ select public.production_order_action(%L, 'SUBMIT') $q$, rls_test.gid('p_old', 'order_id')));
select rls_test.claims('pm2');
select rls_test.call(format($q$ select public.production_order_action(%L, 'APPROVE') $q$, rls_test.gid('p_old', 'order_id')));
reset role;
alter table public.production_order_materials disable trigger production_order_materials_whole_pieces;
update public.production_order_materials set planned_quantity = 0.286 where id = (rls_test.material(rls_test.gid('p_old', 'order_id'), rls_test.id('a1'))).id;
alter table public.production_order_materials enable trigger production_order_materials_whole_pieces;
select rls_test.ok('legacy: A1 now 99 PCS @ GENERAL + 78.571 @ BIN2; A3 48.714 @ GENERAL (as reported in production)',
  rls_test.on_hand(rls_test.id('a1'), rls_test.id('bin2')) = 78.571 and rls_test.on_hand(rls_test.id('a3'), rls_test.id('g1')) = 48.714);
select rls_test.set('ledger_before_audit', to_jsonb(rls_test.ledger_count(rls_test.id('company_a'))));
select rls_test.set('balances_before_audit', (select jsonb_agg(jsonb_build_array(id, on_hand, reserved) order by id) from public.inventory_balances where company_id = rls_test.id('company_a')));

set local role authenticated;
select rls_test.claims('im');
select rls_test.set('audit1', rls_test.call('select public.whole_unit_quantity_audit()'));
select rls_test.ok('audit: runs for an Inventory Manager', not (rls_test.get('audit1') ? 'error'), rls_test.get('audit1')::text);
select rls_test.ok('audit: both fractional balances found as INVALID_PHYSICAL with their values',
  jsonb_array_length(rls_test.findings(rls_test.get('audit1'), 'STOCK_BALANCE', 'INVALID_PHYSICAL')) = 2
  and exists (select 1 from jsonb_array_elements(rls_test.findings(rls_test.get('audit1'), 'STOCK_BALANCE')) e
              where e ->> 'sku' = 'A1' and (e ->> 'value')::numeric = 78.571 and e ->> 'reference' like 'A1 @ W1/BIN2%')
  and exists (select 1 from jsonb_array_elements(rls_test.findings(rls_test.get('audit1'), 'STOCK_BALANCE')) e
              where e ->> 'sku' = 'A3' and (e ->> 'value')::numeric = 48.714));
select rls_test.ok('audit: the source ledger entries are listed with their transaction numbers',
  jsonb_array_length(rls_test.findings(rls_test.get('audit1'), 'LEDGER_ENTRY', 'INVALID_PHYSICAL')) = 2
  and exists (select 1 from jsonb_array_elements(rls_test.findings(rls_test.get('audit1'), 'LEDGER_ENTRY')) e
              where e ->> 'reference' = (select transaction_number from public.inventory_transactions where id = (rls_test.get('legacy_rcpt') #>> '{}')::uuid)));
select rls_test.ok('audit: the legacy fractional order plan is flagged INVALID_PLAN (A1 0.286 on the order)',
  exists (select 1 from jsonb_array_elements(rls_test.findings(rls_test.get('audit1'), 'PRODUCTION_MATERIAL', 'INVALID_PLAN')) e
          where e ->> 'sku' = 'A1' and (e ->> 'value')::numeric = 0.286 and e ->> 'record_id' = rls_test.gid('p_old', 'order_id')::text));
select rls_test.ok('audit: ALD BOM ratios (2 or 1 per 70) are THEORETICAL_RATIO, not errors',
  jsonb_array_length(rls_test.findings(rls_test.get('audit1'), 'BOM_LINE', 'THEORETICAL_RATIO')) >= 3
  and exists (select 1 from jsonb_array_elements(rls_test.findings(rls_test.get('audit1'), 'BOM_LINE', 'THEORETICAL_RATIO')) e
              where e ->> 'sku' = 'A1' and e ->> 'detail' like '2 PCS per 70 PCS of ALD%'));
select rls_test.ok('audit: the draft BOM with 0.5 PCS is NEEDS_CORRECTION',
  exists (select 1 from jsonb_array_elements(rls_test.findings(rls_test.get('audit1'), 'BOM_LINE', 'NEEDS_CORRECTION')) e
          where e ->> 'record_id' = rls_test.gid('bom_fix', 'bom_id')::text));
select rls_test.ok('audit: KG quantities (clay 95.25, 2.5 KG PO line, 5.5 KG dispatch) are never reported',
  not exists (select 1 from jsonb_array_elements(rls_test.get('audit1') -> 'findings') e where e ->> 'unit' = 'KG'));
select rls_test.ok('audit: valid whole-piece history (receipts, issues, output, outsourcing) is not reported',
  jsonb_array_length(rls_test.findings(rls_test.get('audit1'), 'PRODUCTION_ISSUE')) = 0
  and jsonb_array_length(rls_test.findings(rls_test.get('audit1'), 'OUTSOURCING_RECEIPT')) = 0
  and jsonb_array_length(rls_test.findings(rls_test.get('audit1'), 'PURCHASE_ORDER_LINE')) = 0);
reset role;
select rls_test.ok('audit: read only â€” ledger and balances unchanged by running it',
  rls_test.ledger_count(rls_test.id('company_a')) = (rls_test.get('ledger_before_audit'))::bigint
  and (select jsonb_agg(jsonb_build_array(id, on_hand, reserved) order by id) from public.inventory_balances where company_id = rls_test.id('company_a'))
      = rls_test.get('balances_before_audit'));
-- The standalone script (supabase/audit/whole_piece_quantity_audit.sql) is passed in by the
-- local runner; on Supabase (SQL Editor) this check is skipped.
create function rls_test.script_rows() returns jsonb language plpgsql as $$
declare v_sql text := current_setting('wp.audit_script', true); r jsonb;
begin
  if coalesce(v_sql, '') = '' then return null; end if;
  v_sql := regexp_replace(v_sql, '[;[:space:]]+$', '');
  execute format('select coalesce(jsonb_agg(x order by x::text), ''[]''::jsonb) from (select jsonb_build_array(q.company_code, q.category, q.classification, q.reference, q.field, q.value) as x from (%s) q) s', v_sql) into r;
  return r;
end $$;
select rls_test.ok('audit script: the standalone read-only script returns exactly the in-app findings (all but purchasing)',
  rls_test.script_rows() is null
  or rls_test.script_rows() = (
    select coalesce(jsonb_agg(x order by x::text), '[]'::jsonb) from (
      select jsonb_build_array(c.company_code, f.category, f.classification, f.reference, f.field, f.value) as x
      from private.whole_unit_findings(null) f join public.companies c on c.id = f.company_id
      where f.category not in ('PURCHASE_ORDER_LINE', 'GOODS_RECEIPT_LINE')) s),
  coalesce(jsonb_array_length(rls_test.script_rows())::text, 'skipped (script not supplied)'));
select rls_test.ok('audit: the private finding function is not callable by clients',
  not has_function_privilege('authenticated', 'private.whole_unit_findings(uuid)', 'EXECUTE'));

-- Blocking until reconciled
set local role authenticated;
select rls_test.claims('pm');
select rls_test.expect_call_error('legacy: reserving for the order with a fractional plan is refused with an explanation (not rounded)',
  format($q$ select public.production_reserve_materials(%L, false, gen_random_uuid()) $q$, rls_test.gid('p_old', 'order_id')), 'planned before whole-piece rules');
select rls_test.claims('im');
select rls_test.expect_call_error('legacy: reserving the fractional 78.571 is refused',
  format($q$ select public.inventory_create_reservation(%L, %L, 78.571, 'TEST', 'T-2', p_batch_id => %L, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.id('a1'), rls_test.id('bin2'), rls_test.id('lot_a1')), 'whole');
select rls_test.claims('pm');
select rls_test.expect_call_ok('legacy: order for 75 TRI (needs 50 A3, 48.714 on hand)', 'p_tri',
  format($q$ select public.production_save_order(null, %L, 75, %L, %L, %L, %L, p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.gid('bom_tri', 'bom_id'), rls_test.id('w1'), rls_test.id('w1'), rls_test.today(), rls_test.today() + 5));
select rls_test.call(format($q$ select public.production_order_action(%L, 'SUBMIT') $q$, rls_test.gid('p_tri', 'order_id')));
select rls_test.claims('pm2');
select rls_test.call(format($q$ select public.production_order_action(%L, 'APPROVE') $q$, rls_test.gid('p_tri', 'order_id')));
select rls_test.claims('pm');
select rls_test.expect_call_ok('legacy: a partial reservation from the fractional balance takes only whole pieces', 'res_tri',
  format($q$ select public.production_reserve_materials(%L, true, gen_random_uuid()) $q$, rls_test.gid('p_tri', 'order_id')));
select rls_test.ok('legacy: 48 of 48.714 PCS reserved (never 48.714); shortage 2',
  rls_test.open_res(rls_test.gid('p_tri', 'order_id')) = 48 and (rls_test.get('res_tri') -> 'shortages' -> 0 ->> 'short')::numeric = 2);
select rls_test.call(format($q$ select public.production_release_reservations(%L, 'Test') $q$, rls_test.gid('p_tri', 'order_id')));

-- Reconciliation through the existing approved adjustment workflow
select rls_test.claims('im');
select rls_test.expect_call_ok('reconcile: physical count of 78 PCS at BIN2 requested as an adjustment (preview: system 78.571 -> 78)', 'adj1',
  format($q$ select public.inventory_create_adjustment('QUANTITY', %L, %L, 'COUNT_VARIANCE', p_batch_id => %L, p_counted_quantity => 78,
    p_notes => 'Whole-piece reconciliation of legacy fractional stock', p_reference => 'WP-AUDIT', p_idempotency_key => gen_random_uuid()) $q$,
    rls_test.id('a1'), rls_test.id('bin2'), rls_test.id('lot_a1')));
reset role;
select rls_test.ok('reconcile: the request records before (system 78.571) and after (counted 78, difference -0.571); stock not yet changed',
  (select system_quantity = 78.571 and counted_quantity = 78 and difference = -0.571 and status = 'PENDING_APPROVAL'
   from public.inventory_adjustments where id = rls_test.gid('adj1', 'adjustment_id'))
  and rls_test.on_hand(rls_test.id('a1'), rls_test.id('bin2')) = 78.571);
set local role authenticated;
select rls_test.claims('im');
select rls_test.expect_call_error('reconcile: the requester cannot approve their own reconciliation',
  format($q$ select public.inventory_review_adjustment(%L, 'APPROVE', null, gen_random_uuid()) $q$, rls_test.gid('adj1', 'adjustment_id')), 'Segregation');
select rls_test.claims('adm');
select rls_test.expect_call_ok('reconcile: an authorised approver posts it', 'adj1_ok',
  format($q$ select public.inventory_review_adjustment(%L, 'APPROVE', 'Counted', gen_random_uuid()) $q$, rls_test.gid('adj1', 'adjustment_id')));
reset role;
select rls_test.ok('reconcile: BIN2 now exactly 78 PCS via a 0.571 ADJUSTMENT_OUT; the legacy receipt is still in the ledger',
  rls_test.on_hand(rls_test.id('a1'), rls_test.id('bin2')) = 78
  and exists (select 1 from public.inventory_transactions where reference_id = rls_test.gid('adj1', 'adjustment_id') and transaction_type = 'ADJUSTMENT_OUT' and quantity = 0.571)
  and exists (select 1 from public.inventory_transactions where id = (rls_test.get('legacy_rcpt') #>> '{}')::uuid and quantity = 78.571));
select rls_test.ok('reconcile: audit log records the posted adjustment',
  exists (select 1 from public.audit_logs where action = 'inventory.adjustment_posted' and resource_id =rls_test.gid('adj1', 'adjustment_id')::text));

set local role authenticated;
select rls_test.claims('adm');
select rls_test.expect_call_ok('reconcile: the exact reversal of the legacy 0.286 issue is allowed', 'rev1',
  format($q$ select public.inventory_reverse_transaction(%L, 'Fractional issue posted before whole-piece rules', gen_random_uuid()) $q$, (rls_test.get('legacy_issue') #>> '{}')::uuid));
reset role;
select rls_test.ok('reconcile: A3 back to a whole 49 PCS', rls_test.on_hand(rls_test.id('a3'), rls_test.id('g1')) = 49);

-- The ledger guard cannot be bypassed even by a SECURITY DEFINER caller
select rls_test.ok('guard: a fractional adjustment that would CREATE a fraction is refused (99 -> 98.5)',
  rls_test.call(format($q$ select to_jsonb(private.post_movement(%L, 'ADJUSTMENT_OUT', %L, %L, 0.5, null, 'ADJUSTMENT', 'X', null, 'Probe', null, now(), 'ADJUSTMENT', null)) $q$,
    rls_test.id('company_a'), rls_test.id('lot_a1'), rls_test.id('g1'))) ? 'error');
select rls_test.ok('guard: a fractional receipt posted directly through the core is refused',
  rls_test.call(format($q$ select to_jsonb(private.post_movement(%L, 'RECEIPT', %L, %L, 0.5, null, null, null, null, 'Probe', null, now(), 'RECEIPT', null)) $q$,
    rls_test.id('company_a'), rls_test.id('lot_a1'), rls_test.id('g1'))) ? 'error');
select rls_test.ok('guard: adding a whole quantity on top of a historical fractional plan is refused',
  rls_test.call(format($q$ update public.production_order_materials set issued_quantity = issued_quantity + 0.5 where id = %L returning jsonb_build_object('x', 1) $q$,
    (rls_test.material(rls_test.gid('p_old', 'order_id'), rls_test.id('a2'))).id)) ? 'error');

set local role authenticated;
select rls_test.claims('im');
select rls_test.set('audit2', rls_test.call('select public.whole_unit_quantity_audit()'));
select rls_test.ok('audit after reconciliation: no fractional stock balance remains',
  jsonb_array_length(rls_test.findings(rls_test.get('audit2'), 'STOCK_BALANCE')) = 0);
select rls_test.ok('audit after reconciliation: history kept and classified (legacy receipt INVALID_PHYSICAL, reversed issue REVERSED_HISTORY, 0.571 ADJUSTMENT_HISTORY)',
  jsonb_array_length(rls_test.findings(rls_test.get('audit2'), 'LEDGER_ENTRY', 'INVALID_PHYSICAL')) = 1
  and jsonb_array_length(rls_test.findings(rls_test.get('audit2'), 'LEDGER_ENTRY', 'REVERSED_HISTORY')) = 2
  and jsonb_array_length(rls_test.findings(rls_test.get('audit2'), 'LEDGER_ENTRY', 'ADJUSTMENT_HISTORY')) = 1);

-- ===========================================================================
-- Dashboard totals agree with the stock ledger
-- ===========================================================================
select rls_test.set('overview', rls_test.call('select public.inventory_overview()'));
select rls_test.set('reconcile', rls_test.call('select public.inventory_reconcile()'));
reset role;
select rls_test.ok('dashboard: PCS on hand on the inventory overview = sum of the PCS ledger = sum of product stock',
  (select (u ->> 'on_hand')::numeric from jsonb_array_elements(rls_test.get('overview') -> 'units') u where u ->> 'unit' = 'PCS')
    = (select sum(direction * quantity) from public.inventory_transactions where company_id = rls_test.id('company_a') and unit = 'PCS')
  and (select (u ->> 'on_hand')::numeric from jsonb_array_elements(rls_test.get('overview') -> 'units') u where u ->> 'unit' = 'PCS')
    = (select sum(on_hand) from public.inventory_product_stock where company_id = rls_test.id('company_a') and base_unit = 'PCS' and archived_at is null),
  rls_test.get('overview')::text);
select rls_test.ok('dashboard: PCS totals are whole after reconciliation; KG keeps decimals',
  (select bool_and(case when u ->> 'unit' = 'PCS' then (u ->> 'on_hand')::numeric = trunc((u ->> 'on_hand')::numeric) else true end)
   from jsonb_array_elements(rls_test.get('overview') -> 'units') u)
  and (select (u ->> 'on_hand')::numeric from jsonb_array_elements(rls_test.get('overview') -> 'units') u where u ->> 'unit' = 'KG') = 95);
select rls_test.ok('dashboard: available = on hand - reserved for every unit',
  (select bool_and((u ->> 'available')::numeric = (u ->> 'on_hand')::numeric - (u ->> 'reserved')::numeric) from jsonb_array_elements(rls_test.get('overview') -> 'units') u));
select rls_test.ok('ledger reconciliation: balances and reservations match the ledger (0 mismatches)',
  jsonb_array_length(rls_test.get('reconcile') -> 'mismatches') = 0, rls_test.get('reconcile')::text);

-- ===========================================================================
-- Permissions and company isolation
-- ===========================================================================
set local role authenticated;
select rls_test.claims('viewer');
select rls_test.expect_call_error('permissions: a Management Viewer cannot run the audit',
  'select public.whole_unit_quantity_audit()', 'not allowed');
select rls_test.expect_call_error('permissions: a Management Viewer cannot reserve materials',
  format($q$ select public.production_reserve_materials(%L, false, gen_random_uuid()) $q$, rls_test.gid('p_tri', 'order_id')), 'not allowed');
select rls_test.claims('b_im');
select rls_test.set('audit_b', rls_test.call('select public.whole_unit_quantity_audit()'));
select rls_test.ok('isolation: company B''s audit contains none of company A''s findings',
  not (rls_test.get('audit_b') ? 'error') and (rls_test.get('audit_b') ->> 'total')::int = 0, rls_test.get('audit_b')::text);
select rls_test.expect_call_error('isolation: company B cannot plan with company A''s BOM',
  format('select count(*) from public.production_bom_requirements(%L, 10)', rls_test.gid('bom_ald', 'bom_id')), 'not found');
select rls_test.expect_call_error('isolation: company B cannot reserve for company A''s order',
  format($q$ select public.production_reserve_materials(%L, false, gen_random_uuid()) $q$, rls_test.gid('p_tri', 'order_id')), 'not found');
select rls_test.expect_call_error('isolation: company B still cannot post 0.5 PCS in its own company',
  format($q$ select public.inventory_post_receipt(%L, %L, 0.5, 'OUTSOURCED', p_idempotency_key => gen_random_uuid()) $q$, rls_test.id('b_a1'), rls_test.id('gb')), 'whole');
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
  raise exception 'WHOLE_PIECE_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
