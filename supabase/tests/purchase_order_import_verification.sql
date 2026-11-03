-- =============================================================================
-- SUPPLIER PO EXCEL IMPORT VERIFICATION
--
-- Executable checks for purchase_order_import_preview / purchase_order_import:
-- permissions, company isolation, code resolution, row-level errors, GST via the
-- existing engine, per-order atomicity (including numbering), retried requests,
-- duplicate orders across files, ignored privileged spreadsheet values, import
-- history / audit, and that imports create drafts only (no stock postings).
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction with its own companies (SPIA / SPIB) and ALWAYS ends
-- by raising PO_IMPORT_VERIFICATION_RESULT passed=N failed=M so that all test
-- rows are rolled back.
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
create function rls_test.expect_rows(p_name text, p_sql text, p_expected int) returns void language plpgsql as $$
declare n int;
begin execute format('select count(*) from (%s) q', p_sql) into n;
  perform rls_test.ok(p_name, n = p_expected, format('rows=%s expected=%s', n, p_expected));
exception when others then perform rls_test.ok(p_name, false, format('unexpected error %s: %s', sqlstate, sqlerrm)); end $$;
create function rls_test.expect_call_ok(p_name text, p_key text, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.set(p_key, r); perform rls_test.ok(p_name, not (r ? 'error'), r::text); return r; end $$;
create function rls_test.expect_call_error(p_name text, p_sql text, p_pattern text default null, p_state text default null) returns void language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.ok(p_name, r ? 'error' and (p_pattern is null or r ->> 'error' ilike '%' || p_pattern || '%')
  and (p_state is null or r ->> 'sqlstate' = p_state), r::text); end $$;
create function rls_test.claims(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', rls_test.id(p_key), 'role', 'authenticated')::text, true) $$;

-- Builders: one spreadsheet row and one order (group of rows)
create function rls_test.r(p_row int, p_sku text, p_qty text, p_price text, p_extra jsonb default '{}'::jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('row_number', p_row, 'sku', p_sku, 'quantity', p_qty, 'unit_price', p_price) || p_extra $$;
create function rls_test.g(p_ref text, p_supplier text, p_rows jsonb, p_header jsonb default '{}'::jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('reference', p_ref, 'header', jsonb_build_object('supplier_code', p_supplier, 'warehouse', 'W1') || p_header, 'rows', p_rows) $$;
create function rls_test.preview(p_groups jsonb) returns text language sql immutable as $$
  select format('select public.purchase_order_import_preview(%L::jsonb)', p_groups) $$;
create function rls_test.import(p_groups jsonb, p_key uuid, p_rejected jsonb default '[]'::jsonb) returns text language sql immutable as $$
  select format('select public.purchase_order_import(%L::jsonb, %L::jsonb, %L::jsonb, %L)', p_groups,
    jsonb_build_object('file_name', 'po-upload.xlsx', 'file_hash', repeat('ab', 32), 'total_rows', 7), p_rejected, p_key) $$;
create function rls_test.grp(p_res jsonb, p_ref text) returns jsonb language sql immutable as $$
  select g from jsonb_array_elements(p_res -> 'groups') g where g ->> 'reference' = p_ref $$;
create function rls_test.errs(p_group jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(format('[row %s] %s', e ->> 'row', e ->> 'message'), ' '), '') from jsonb_array_elements(coalesce(p_group -> 'errors', '[]'::jsonb)) e $$;
create function rls_test.po_count(p_company uuid) returns int language sql stable security definer as $$
  select count(*)::int from public.purchase_orders where company_id = p_company $$;
create function rls_test.po_by_number(p_company uuid, p_number text) returns public.purchase_orders language sql stable security definer as $$
  select * from public.purchase_orders where company_id = p_company and po_number = p_number $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e57700-0000-4000-8000-0000000000a1'), ('company_b', 'e7e57700-0000-4000-8000-0000000000b1'),
  ('pm', 'e7e57700-0000-4000-8000-000000000002'), ('inv', 'e7e57700-0000-4000-8000-000000000003'),
  ('acct', 'e7e57700-0000-4000-8000-000000000004'), ('viewer', 'e7e57700-0000-4000-8000-000000000005'),
  ('b_pm', 'e7e57700-0000-4000-8000-000000000006'),
  ('s_intra', 'e7e57700-0000-4000-8000-0000000000c1'), ('s_inter', 'e7e57700-0000-4000-8000-0000000000c2'),
  ('s_old', 'e7e57700-0000-4000-8000-0000000000c3'), ('b_sup', 'e7e57700-0000-4000-8000-0000000000c4'),
  ('basin', 'e7e57700-0000-4000-8000-0000000000d1'), ('clay', 'e7e57700-0000-4000-8000-0000000000d2'),
  ('old', 'e7e57700-0000-4000-8000-0000000000d3'), ('b_only', 'e7e57700-0000-4000-8000-0000000000d4'),
  ('w1', 'e7e57700-0000-4000-8000-0000000000e1'), ('wb', 'e7e57700-0000-4000-8000-0000000000e2');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code, gstin, legal_address) values
  (rls_test.id('company_a'), 'Import Buyer A', 'Import Buyer A', 'SPIA', '27AAACI1234A1Z5', 'Pune'),
  (rls_test.id('company_b'), 'Import Buyer B', 'Import Buyer B', 'SPIB', '29AAACI1234B1Z5', 'Bengaluru');
-- V2 turns segregation of duties off by default (single operator). This suite tests it, so it switches it on.
insert into public.company_settings (company_id, setting_key, setting_value)
select id, 'inventory.segregation_of_duties', 'true'::jsonb from public.companies where id in (rls_test.id('company_a'), rls_test.id('company_b'));
insert into auth.users (id, email) select id, key || '@spi.example.invalid' from rls_test.ids where key in ('pm', 'inv', 'acct', 'viewer', 'b_pm');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id in (select id from rls_test.ids where key in ('pm', 'inv', 'acct', 'viewer'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_pm');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('pm'), rls_test.id('company_a'), rls_test.id('role_purchase_manager')),
  (rls_test.id('inv'), rls_test.id('company_a'), rls_test.id('role_inventory_manager')),
  (rls_test.id('acct'), rls_test.id('company_a'), rls_test.id('role_accounts_manager')),
  (rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_management_viewer')),
  (rls_test.id('b_pm'), rls_test.id('company_b'), rls_test.id('role_purchase_manager'));
insert into public.suppliers (id, company_id, supplier_code, legal_name, gstin, state_code, category, status) values
  (rls_test.id('s_intra'), rls_test.id('company_a'), 'S-INTRA', 'Pune Ceramics Pvt Ltd', '27AAPFU0939F1ZV', '27', 'FINISHED_GOODS', 'ACTIVE'),
  (rls_test.id('s_inter'), rls_test.id('company_a'), 'S-INTER', 'Morbi Tiles LLP', '24ABCDE1234F1Z5', '24', 'RAW_MATERIAL', 'ACTIVE'),
  (rls_test.id('s_old'), rls_test.id('company_a'), 'S-OLD', 'Old Vendor', null, '27', 'OTHER', 'INACTIVE'),
  (rls_test.id('b_sup'), rls_test.id('company_b'), 'S-B', 'B Supplier', '29AAPFU0939F1ZW', '29', 'OTHER', 'ACTIVE');
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, track_batches, track_expiry, status, hsn_code, gst_rate) values
  (rls_test.id('basin'), rls_test.id('company_a'), 'IMP-BASIN', 'Wash basin', 'FINISHED_GOOD', 'OUTSOURCED', 'PCS', false, false, 'ACTIVE', '6910', 18),
  (rls_test.id('clay'), rls_test.id('company_a'), 'IMP-CLAY', 'Ball clay', 'RAW_MATERIAL', 'IN_HOUSE', 'KG', false, false, 'ACTIVE', '2508', 5),
  (rls_test.id('old'), rls_test.id('company_a'), 'IMP-OLD', 'Old basin', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, 'INACTIVE', null, 18),
  (rls_test.id('b_only'), rls_test.id('company_b'), 'B-ONLY', 'B product', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, 'ACTIVE', null, 18);
insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Main', true), (rls_test.id('wb'), rls_test.id('company_b'), 'WB', 'B main', true);

-- Orders used below
select rls_test.set('g_ok', rls_test.g('IMP-1', 's-intra', jsonb_build_array(
  rls_test.r(2, 'imp-basin', '10', '1000', '{"discount_percent": "10"}'),
  rls_test.r(3, 'IMP-CLAY', '2.5', '333.3333', '{"gst_rate": "5", "unit": "kg"}')), '{"supplier_name": "Pune Ceramics Pvt Ltd", "supplier_gstin": "27AAPFU0939F1ZV", "supplier_state": "Maharashtra"}'));
select rls_test.set('g_inter', rls_test.g('IMP-2', 'S-INTER', jsonb_build_array(rls_test.r(4, 'IMP-BASIN', '3', '999.99', '{"gst_rate": "12"}'))));
select rls_test.set('g_badqty', rls_test.g('IMP-3', 'S-INTRA', jsonb_build_array(rls_test.r(5, 'IMP-BASIN', '1', '100'), rls_test.r(6, 'IMP-CLAY', '0', '10'))));
select rls_test.set('g_badsku', rls_test.g('IMP-4', 'S-INTRA', jsonb_build_array(rls_test.r(7, 'NO-SUCH', '1', '10'))));

-- ---------------------------------------------------------------------------
-- Schema and permissions
-- ---------------------------------------------------------------------------
select rls_test.ok('schema: import references have RLS, are read-only for clients and append-only',
  (select relrowsecurity from pg_class where oid = 'public.purchase_order_import_refs'::regclass)
  and not has_table_privilege('authenticated', 'public.purchase_order_import_refs', 'INSERT,UPDATE,DELETE'));
select rls_test.ok('schema: anon cannot call the import functions',
  not has_function_privilege('anon', 'public.purchase_order_import_preview(jsonb, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.purchase_order_import(jsonb, jsonb, jsonb, uuid)', 'EXECUTE'));

set local role authenticated;
select rls_test.claims('viewer');
select rls_test.expect_call_error('permissions: Management Viewer (read only) cannot preview an import', rls_test.preview(jsonb_build_array(rls_test.get('g_ok'))), 'purchase_order.create', '42501');
select rls_test.claims('inv');
select rls_test.expect_call_error('permissions: Inventory Manager cannot import purchase orders', rls_test.import(jsonb_build_array(rls_test.get('g_ok')), gen_random_uuid()), 'purchase_order.create', '42501');
select rls_test.claims('acct');
select rls_test.expect_call_error('permissions: Accounts Manager cannot import purchase orders', rls_test.import(jsonb_build_array(rls_test.get('g_ok')), gen_random_uuid()), 'purchase_order.create', '42501');

-- ---------------------------------------------------------------------------
-- Preview (validated and calculated by the real functions, then rolled back)
-- ---------------------------------------------------------------------------
select rls_test.claims('pm');
select rls_test.expect_call_ok('preview: Purchase Manager previews a mixed file', 'pv', rls_test.preview(jsonb_build_array(
  rls_test.get('g_ok'), rls_test.get('g_inter'), rls_test.get('g_badqty'), rls_test.get('g_badsku'),
  rls_test.g('E-SUP', 'NOPE', jsonb_build_array(rls_test.r(10, 'IMP-BASIN', '1', '1'))),
  rls_test.g('E-RATE', 'S-INTRA', jsonb_build_array(rls_test.r(11, 'IMP-BASIN', '1', '1', '{"gst_rate": "7"}'))),
  rls_test.g('E-WH', 'S-INTRA', jsonb_build_array(rls_test.r(12, 'IMP-BASIN', '1', '1')), '{"warehouse": "W9"}'),
  rls_test.g('E-GSTIN', 'S-INTRA', jsonb_build_array(rls_test.r(13, 'IMP-BASIN', '1', '1')), '{"supplier_gstin": "24ABCDE1234F1Z5"}'),
  rls_test.g('E-BSUP', 'S-B', jsonb_build_array(rls_test.r(14, 'IMP-BASIN', '1', '1'))),
  rls_test.g('E-BPROD', 'S-INTRA', jsonb_build_array(rls_test.r(15, 'B-ONLY', '1', '1'))),
  rls_test.g('E-OLD', 'S-INTRA', jsonb_build_array(rls_test.r(16, 'IMP-OLD', '1', '1'))),
  rls_test.g('E-SOLD', 'S-OLD', jsonb_build_array(rls_test.r(17, 'IMP-BASIN', '1', '1'))),
  rls_test.g('E-UNIT', 'S-INTRA', jsonb_build_array(rls_test.r(18, 'IMP-BASIN', '1', '1', '{"unit": "KG"}'))),
  rls_test.g('E-HDR', 'S-INTRA', jsonb_build_array(rls_test.r(19, 'IMP-BASIN', '1', '1'), rls_test.r(20, 'IMP-CLAY', '1', '1', '{"warehouse": "WX"}'))),
  rls_test.g('E-WARN', 'S-INTRA', jsonb_build_array(rls_test.r(21, 'IMP-BASIN', '1', '1', '{"product_name": "Something else"}')), '{"supplier_name": "Other name"}')
)));
select rls_test.ok('preview: valid order calculated by the existing engine (intra-state): basin 9000 + 810 + 810, clay 833.33 + 20.83 x 2; grand 11494.99',
  (rls_test.grp(rls_test.get('pv'), 'IMP-1') ->> 'ok')::boolean and rls_test.grp(rls_test.get('pv'), 'IMP-1') ->> 'tax_treatment' = 'INTRA_STATE'
  and (rls_test.grp(rls_test.get('pv'), 'IMP-1') -> 'totals' ->> 'grand')::numeric = 11494.99
  and (rls_test.grp(rls_test.get('pv'), 'IMP-1') -> 'totals' ->> 'cgst')::numeric = 830.83
  and (rls_test.grp(rls_test.get('pv'), 'IMP-1') -> 'lines' -> 0 ->> 'row')::int = 2
  and (rls_test.grp(rls_test.get('pv'), 'IMP-1') -> 'lines' -> 0 ->> 'gst_rate')::numeric = 18
  and (rls_test.grp(rls_test.get('pv'), 'IMP-1') -> 'lines' -> 1 ->> 'total')::numeric = 874.99,
  (rls_test.grp(rls_test.get('pv'), 'IMP-1'))::text);
select rls_test.ok('preview: inter-state supplier -> IGST only (3 x 999.99 = 2999.97, IGST 12% = 360.00)',
  rls_test.grp(rls_test.get('pv'), 'IMP-2') ->> 'tax_treatment' = 'INTER_STATE' and (rls_test.grp(rls_test.get('pv'), 'IMP-2') -> 'totals' ->> 'igst')::numeric = 360
  and (rls_test.grp(rls_test.get('pv'), 'IMP-2') -> 'totals' ->> 'cgst')::numeric = 0);
select rls_test.ok('preview: an invalid line error from the PO engine is reported on its spreadsheet row (row 6)',
  not (rls_test.grp(rls_test.get('pv'), 'IMP-3') ->> 'ok')::boolean and rls_test.errs(rls_test.grp(rls_test.get('pv'), 'IMP-3')) ilike '[row 6]%quantity must be greater than zero%',
  rls_test.errs(rls_test.grp(rls_test.get('pv'), 'IMP-3')));
select rls_test.ok('preview: unknown product code reported on row 7 (products are never created)',
  rls_test.errs(rls_test.grp(rls_test.get('pv'), 'IMP-4')) ilike '[row 7]%Product code "NO-SUCH" was not found%never create products%');
select rls_test.ok('preview: unknown supplier code reported (suppliers are never created)', rls_test.errs(rls_test.grp(rls_test.get('pv'), 'E-SUP')) ilike '[row 10]%Supplier code "NOPE" was not found%never create suppliers%');
select rls_test.ok('preview: unsupported GST rate rejected', rls_test.errs(rls_test.grp(rls_test.get('pv'), 'E-RATE')) ilike '[row 11]%GST rate "7" is not a rate used by the ERP%');
select rls_test.ok('preview: unknown warehouse rejected', rls_test.errs(rls_test.grp(rls_test.get('pv'), 'E-WH')) ilike '[row 12]%Warehouse "W9" was not found%');
select rls_test.ok('preview: supplier GSTIN that does not match the record rejected', rls_test.errs(rls_test.grp(rls_test.get('pv'), 'E-GSTIN')) ilike '%does not match supplier S-INTRA%');
select rls_test.ok('isolation: another company''s supplier code is "not found"', rls_test.errs(rls_test.grp(rls_test.get('pv'), 'E-BSUP')) ilike '%Supplier code "S-B" was not found%');
select rls_test.ok('isolation: another company''s product code is "not found"', rls_test.errs(rls_test.grp(rls_test.get('pv'), 'E-BPROD')) ilike '%Product code "B-ONLY" was not found%');
select rls_test.ok('preview: inactive product and inactive supplier rejected',
  rls_test.errs(rls_test.grp(rls_test.get('pv'), 'E-OLD')) ilike '%IMP-OLD is inactive%' and rls_test.errs(rls_test.grp(rls_test.get('pv'), 'E-SOLD')) ilike '%S-OLD is inactive%');
select rls_test.ok('preview: unit that differs from the product''s unit rejected', rls_test.errs(rls_test.grp(rls_test.get('pv'), 'E-UNIT')) ilike '%Unit KG does not match the product''s unit PCS%');
select rls_test.ok('preview: rows of one order with different order details rejected (no silent merge)', rls_test.errs(rls_test.grp(rls_test.get('pv'), 'E-HDR')) ilike '[row 20]%Warehouse differs from the first row%');
select rls_test.ok('preview: different supplier / product names are warnings, not errors (matched by code)',
  (rls_test.grp(rls_test.get('pv'), 'E-WARN') ->> 'ok')::boolean and jsonb_array_length(rls_test.grp(rls_test.get('pv'), 'E-WARN') -> 'warnings') = 2);
reset role;
select rls_test.ok('preview: nothing was saved and no PO number was used', rls_test.po_count(rls_test.id('company_a')) = 0
  and not exists (select 1 from public.inventory_number_sequences where company_id = rls_test.id('company_a') and prefix = 'PO'));
set local role authenticated;
select rls_test.claims('pm');
select rls_test.expect_call_error('limits: more than 100 orders in one import refused',
  rls_test.preview((select jsonb_agg(rls_test.g('L' || n, 'S-INTRA', jsonb_build_array(rls_test.r(n + 1, 'IMP-BASIN', '1', '1')))) from generate_series(1, 101) n)), 'At most 100');
select rls_test.expect_call_error('limits: more than 1000 rows in one import refused',
  rls_test.preview(jsonb_build_array(rls_test.g('BIG', 'S-INTRA', (select jsonb_agg(rls_test.r(n + 1, 'IMP-BASIN', '1', '1')) from generate_series(1, 1001) n)))), 'At most 1000');

-- ---------------------------------------------------------------------------
-- Import
-- ---------------------------------------------------------------------------
select rls_test.set('g_priv', rls_test.g('IMP-5', 'S-INTRA', jsonb_build_array(rls_test.r(8, 'IMP-BASIN', '2', '50')),
  jsonb_build_object('company_id', rls_test.id('company_b'), 'supplier_id', rls_test.id('b_sup'), 'status', 'APPROVED', 'approved_by', rls_test.id('pm'), 'warehouse_id', rls_test.id('wb'))));
select rls_test.expect_call_ok('import: Purchase Manager imports 3 valid and 2 invalid orders (+1 row rejected in the browser)', 'imp',
  rls_test.import(jsonb_build_array(rls_test.get('g_ok'), rls_test.get('g_inter'), rls_test.get('g_badqty'), rls_test.get('g_badsku'), rls_test.get('g_priv')),
    'e7e57700-0000-4000-8000-00000000aa01', '[{"row_number": 40, "reference": "IMP-9", "messages": ["PO Date: use YYYY-MM-DD"]}]'::jsonb));
select rls_test.ok('import: 3 drafts created, 2 orders not imported; counts reported',
  (rls_test.get('imp') ->> 'created_count')::int = 3 and (rls_test.get('imp') ->> 'failed_count')::int = 2
  and (rls_test.get('imp') ->> 'imported_rows')::int = 4 and (rls_test.get('imp') ->> 'failed_rows')::int = 4, rls_test.get('imp')::text);
reset role;
select rls_test.ok('atomic: the order with a bad second line left no PO and used no number (PO-000001..3 contiguous)',
  (select array_agg(po_number order by po_number) from public.purchase_orders where company_id = rls_test.id('company_a')) = array['PO-000001', 'PO-000002', 'PO-000003']
  and not exists (select 1 from public.purchase_order_lines l join public.purchase_orders o on o.id = l.purchase_order_id
                  where o.company_id = rls_test.id('company_a') and l.ordered_quantity = 0));
select rls_test.ok('import: all imported orders are DRAFT, not submitted, approved or sent',
  (select bool_and(status = 'DRAFT' and submitted_at is null and approved_by is null and sent_at is null) from public.purchase_orders where company_id = rls_test.id('company_a')));
select rls_test.ok('import: totals of the created draft equal the preview (11494.99) and lines keep the product GST rate',
  (rls_test.po_by_number(rls_test.id('company_a'), 'PO-000001')).grand_total = 11494.99
  and (select array_agg(gst_rate order by line_no) from public.purchase_order_lines where purchase_order_id = (rls_test.po_by_number(rls_test.id('company_a'), 'PO-000001')).id) = array[18, 5]::numeric[]);
select rls_test.ok('import: spreadsheet company / supplier id / status / approver / warehouse id values are ignored',
  (rls_test.po_by_number(rls_test.id('company_a'), 'PO-000003')).supplier_id = rls_test.id('s_intra')
  and (rls_test.po_by_number(rls_test.id('company_a'), 'PO-000003')).warehouse_id = rls_test.id('w1')
  and (rls_test.po_by_number(rls_test.id('company_a'), 'PO-000003')).status = 'DRAFT'
  and rls_test.po_count(rls_test.id('company_b')) = 0);
select rls_test.ok('import: purchase type from the supplier category; created by the importing user',
  (rls_test.po_by_number(rls_test.id('company_a'), 'PO-000002')).purchase_type = 'RAW_MATERIAL'
  and (select bool_and(created_by = rls_test.id('pm')) from public.purchase_orders where company_id = rls_test.id('company_a')));
select rls_test.ok('import: no stock ledger entries and no goods receipts were created',
  not exists (select 1 from public.inventory_transactions where company_id = rls_test.id('company_a'))
  and not exists (select 1 from public.goods_receipts where company_id = rls_test.id('company_a')));
select rls_test.ok('import: references link each draft to the file, reference and spreadsheet rows',
  (select count(*) from public.purchase_order_import_refs where company_id = rls_test.id('company_a')) = 3
  and exists (select 1 from public.purchase_order_import_refs where import_reference = 'IMP-1' and source_rows = array[2, 3] and file_name = 'po-upload.xlsx'));
select rls_test.ok('history: run recorded in import_jobs (SUPPLIER_PO, 4 rows imported, 4 failed incl. the browser-rejected row) with row messages',
  exists (select 1 from public.import_jobs where company_id = rls_test.id('company_a') and import_type = 'SUPPLIER_PO' and client_job_key = 'e7e57700-0000-4000-8000-00000000aa01'
          and status = 'COMPLETED_WITH_ERRORS' and success_rows = 4 and failed_rows = 4)
  and exists (select 1 from public.import_job_rows r join public.import_jobs j on j.id = r.job_id where j.company_id = rls_test.id('company_a') and r.row_number = 7)
  and exists (select 1 from public.import_job_rows r join public.import_jobs j on j.id = r.job_id where j.company_id = rls_test.id('company_a') and r.row_number = 40));
select rls_test.ok('audit: import.completed and purchasing.imported / purchasing.created recorded for the importing user',
  exists (select 1 from public.audit_logs where company_id = rls_test.id('company_a') and action = 'import.completed' and actor_user_id = rls_test.id('pm'))
  and (select count(*) from public.audit_logs where company_id = rls_test.id('company_a') and action = 'purchasing.imported') = 3
  and (select count(*) from public.audit_logs where company_id = rls_test.id('company_a') and action = 'purchasing.created') = 3);

set local role authenticated;
select rls_test.claims('pm');
select rls_test.expect_call_ok('duplicates: retrying the same import request returns the first result', 'imp_retry',
  rls_test.import(jsonb_build_array(rls_test.get('g_ok'), rls_test.get('g_inter')), 'e7e57700-0000-4000-8000-00000000aa01'));
select rls_test.ok('duplicates: the retry created nothing', (rls_test.get('imp_retry') ->> 'duplicate')::boolean and rls_test.po_count(rls_test.id('company_a')) = 3);
select rls_test.expect_call_ok('duplicates: importing the same orders again (new request, e.g. the same file twice)', 'imp_again',
  rls_test.import(jsonb_build_array(rls_test.get('g_ok'), rls_test.get('g_inter')), 'e7e57700-0000-4000-8000-00000000aa02'));
select rls_test.ok('duplicates: already-imported PO references are refused per supplier; still 3 POs',
  (rls_test.get('imp_again') ->> 'created_count')::int = 0 and rls_test.po_count(rls_test.id('company_a')) = 3
  and (rls_test.get('imp_again') -> 'failed' -> 0 -> 'errors' -> 0 ->> 'message') ilike '%already imported for supplier S-INTRA as PO-000001%', rls_test.get('imp_again')::text);
select rls_test.ok('duplicates: the preview also flags them and lists the earlier import of the same file',
  rls_test.errs(rls_test.grp(public.purchase_order_import_preview(jsonb_build_array(rls_test.get('g_ok')), repeat('ab', 32)), 'IMP-1')) ilike '%already imported%'
  and jsonb_array_length(public.purchase_order_import_preview(jsonb_build_array(rls_test.get('g_ok')), repeat('ab', 32)) -> 'previous_imports') = 2);
select rls_test.expect_call_ok('workflow: an imported draft goes through the normal submission', 'sub',
  format('select public.purchase_order_action(%L, %L)', (rls_test.po_by_number(rls_test.id('company_a'), 'PO-000001')).id, 'SUBMIT'));
select rls_test.expect_call_error('workflow: the importer still cannot approve their own imported order (segregation of duties)',
  format('select public.purchase_order_action(%L, %L)', (rls_test.po_by_number(rls_test.id('company_a'), 'PO-000001')).id, 'APPROVE'), 'Segregation of duties', '42501');

select rls_test.claims('b_pm');
select rls_test.expect_rows('isolation: company B sees none of company A''s import references', 'select 1 from public.purchase_order_import_refs', 0);
select rls_test.expect_rows('isolation: company B sees none of company A''s import history', 'select 1 from public.import_jobs where import_type = ''SUPPLIER_PO''', 0);
select rls_test.expect_call_ok('isolation: company B importing company A''s codes creates nothing', 'b_imp',
  rls_test.import(jsonb_build_array(rls_test.get('g_ok')), 'e7e57700-0000-4000-8000-00000000bb01'));
select rls_test.ok('isolation: company A''s supplier and products are "not found" for company B',
  (rls_test.get('b_imp') ->> 'created_count')::int = 0 and rls_test.errs(rls_test.get('b_imp') -> 'failed' -> 0) ilike '%Supplier code "s-intra" was not found%'
  and rls_test.errs(rls_test.get('b_imp') -> 'failed' -> 0) ilike '%Product code "IMP-CLAY" was not found%'
  and rls_test.po_count(rls_test.id('company_b')) = 0, rls_test.get('b_imp')::text);

reset role;

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
  raise exception 'PO_IMPORT_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
