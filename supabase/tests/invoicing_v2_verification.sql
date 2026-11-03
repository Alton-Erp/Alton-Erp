-- =============================================================================
-- INVOICING VERIFICATION (ALTON ERP V2, Stage 6)
--
-- Checks migration 20261107090000_invoicing_v2.sql end to end: manual invoices
-- (line and invoice-level discounts, charges, CGST+SGST / IGST, tax-inclusive
-- prices, rounding modes), sales-order invoices with partial invoicing and no
-- double billing (also against dispatch invoicing), proforma invoices, one-step
-- issue with unique numbering (no reuse after cancellation), draft editing,
-- payments (partial, multiple, duplicates, excess as advance, applying an
-- advance, reversal), credit and debit notes, the dashboard, the Excel import
-- (grouping, validation, re-upload safety), settings and company isolation.
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction and ALWAYS ends by raising
--   INVOICING_V2_VERIFICATION_RESULT passed=N failed=M
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

create function rls_test.save(p_id uuid, p_header jsonb, p_lines jsonb, p_charges jsonb default null) returns text language sql stable as $$
  select format('select public.sales_invoice_v2_save(%L, %L::jsonb, %L::jsonb, %L::jsonb, %L)', p_id, p_header, p_lines, p_charges, gen_random_uuid()) $$;
create function rls_test.issue(p_id uuid, p_convert boolean default false) returns text language sql stable as $$
  select format('select public.sales_invoice_v2_issue(%L, %L, %L)', p_id, p_convert, gen_random_uuid()) $$;
create function rls_test.pay(p_id uuid, p_payment jsonb) returns text language sql stable as $$
  select format('select public.invoice_v2_record_payment(%L, %L::jsonb, %L)', p_id, p_payment, gen_random_uuid()) $$;
create function rls_test.ln(p_product uuid, p_qty numeric, p_extra jsonb default '{}'::jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('product_id', p_product, 'quantity', p_qty) || p_extra $$;
create function rls_test.grn(p_product uuid, p_qty numeric, p_cost numeric) returns text language sql stable as $$
  select format('select public.goods_receipt_direct_post(%L::jsonb, %L::jsonb, %L)',
    jsonb_build_object('warehouse_id', rls_test.id('w1')),
    jsonb_build_array(jsonb_build_object('product_id', p_product, 'received_quantity', p_qty, 'accepted_quantity', p_qty, 'unit_cost', p_cost,
      'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()) $$;

-- Owner-side probes (bypass RLS).
create function rls_test.inv(p_id uuid) returns public.sales_invoices language sql stable security definer as $$ select * from public.sales_invoices where id = p_id $$;
create function rls_test.inv_line(p_id uuid, p_no int) returns public.sales_invoice_lines language sql stable security definer as $$
  select * from public.sales_invoice_lines where invoice_id = p_id and line_no = p_no $$;
create function rls_test.list(p_id uuid) returns jsonb language sql stable security definer as $$
  select to_jsonb(l) from public.sales_invoice_list l where id = p_id $$;
create function rls_test.balance(p_id uuid) returns numeric language sql stable security definer as $$ select private.invoice_balance(p_id) $$;
create function rls_test.sol(p_so uuid, p_product uuid) returns public.sales_order_lines language sql stable security definer as $$
  select * from public.sales_order_lines where sales_order_id = p_so and product_id = p_product order by line_no limit 1 $$;
create function rls_test.so_line(p_lines jsonb, p_sku text) returns jsonb language sql immutable as $$
  select l from jsonb_array_elements(p_lines -> 'lines') l where l ->> 'sku' = p_sku limit 1 $$;
create function rls_test.dispatch_left(p_so_line uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(private.dispatch_line_invoiceable(fl.id)), 0) from public.fulfilment_lines fl where fl.sales_order_line_id = p_so_line $$;
create function rls_test.fl(p_so_line uuid) returns uuid language sql stable security definer as $$
  select id from public.fulfilment_lines where sales_order_line_id = p_so_line order by created_at limit 1 $$;
create function rls_test.tx_count(p_company uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.inventory_transactions where company_id = p_company $$;
create function rls_test.events(p_id uuid) returns text[] language sql stable security definer as $$
  select array_agg(event_type order by created_at, id) from public.billing_events where invoice_id = p_id $$;
create function rls_test.job(p_id uuid) returns public.import_jobs language sql stable security definer as $$ select * from public.import_jobs where id = p_id $$;
create function rls_test.inv_by_number(p_company uuid, p_number text) returns public.sales_invoices language sql stable security definer as $$
  select * from public.sales_invoices where company_id = p_company and invoice_number = p_number $$;
create function rls_test.inv_count(p_company uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.sales_invoices where company_id = p_company $$;
create function rls_test.balances_reconcile(p_company uuid) returns boolean language sql stable security definer as $$
  select not exists (select 1 from public.sales_invoice_list l where l.company_id = p_company and l.status = 'ISSUED'
    and l.balance_due <> private.invoice_balance(l.id))
  and not exists (select 1 from public.sales_invoices i where i.company_id = p_company
    and i.grand_total <> (select coalesce(sum(line_total), 0) from public.sales_invoice_lines where invoice_id = i.id) + i.round_off) $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures: company in Maharashtra (27); customer X in 27, customer Y in 24
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5c700-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5c700-0000-4000-8000-0000000000b1'),
  ('op', 'e7e5c700-0000-4000-8000-000000000001'), ('b_op', 'e7e5c700-0000-4000-8000-000000000002'),
  ('cx', 'e7e5c700-0000-4000-8000-0000000000c1'), ('cy', 'e7e5c700-0000-4000-8000-0000000000c2'), ('cz', 'e7e5c700-0000-4000-8000-0000000000c3'),
  ('a', 'e7e5c700-0000-4000-8000-0000000000d1'), ('b', 'e7e5c700-0000-4000-8000-0000000000d2'), ('kg', 'e7e5c700-0000-4000-8000-0000000000d3'),
  ('w1', 'e7e5c700-0000-4000-8000-0000000000e1'), ('wb', 'e7e5c700-0000-4000-8000-0000000000e2');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code, gstin, legal_address) values
  (rls_test.id('company_a'), 'Invoicing V2 A Pvt Ltd', 'Inv A', 'IVA', '27AAACI9876A1Z5', 'Plot 4, MIDC, Pune'),
  (rls_test.id('company_b'), 'Invoicing V2 B', 'Inv B', 'IVB', null, null);
insert into auth.users (id, email) select id, key || '@iv.example.invalid' from rls_test.ids where key in ('op', 'b_op');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = rls_test.id('op');
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_op');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('op'), rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('b_op'), rls_test.id('company_b'), rls_test.id('role_super_admin'));
insert into public.customers (id, company_id, customer_code, customer_name, status, gstin, gst_registration_type, pan, billing_state_code, billing_address) values
  (rls_test.id('cx'), rls_test.id('company_a'), 'CUS-X', 'Xylo Homes', 'ACTIVE', '27AABCX1234A1Z5', 'REGISTERED', 'AABCX1234A', '27', 'Baner, Pune'),
  (rls_test.id('cy'), rls_test.id('company_a'), 'CUS-Y', 'Yamuna Builders', 'ACTIVE', '24AABCY1234A1Z5', 'REGISTERED', null, '24', 'Ahmedabad'),
  (rls_test.id('cz'), rls_test.id('company_a'), 'CUS-Z', 'Zed Closed', 'INACTIVE', null, 'UNREGISTERED', null, '27', 'Pune');
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, track_batches, track_expiry, status,
  selling_price, gst_rate, hsn_code) values
  (rls_test.id('a'),  rls_test.id('company_a'), 'IV-A', 'Wash basin', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, 'ACTIVE', 1000, 18, '69101000'),
  (rls_test.id('b'),  rls_test.id('company_a'), 'IV-B', 'Pedestal', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, 'ACTIVE', 500, 12, '6910'),
  (rls_test.id('kg'), rls_test.id('company_a'), 'IV-KG', 'Glaze powder', 'FINISHED_GOOD', 'OUTSOURCED', 'KG', false, false, 'ACTIVE', 200, 5, '3207');
-- This suite tests invoice mechanics (GST, numbering, payments, import) with manual and
-- sales-order invoices that are never dispatched, so its products are classified as
-- non-stock. The dispatch-before-posting rule (20261112) is tested in
-- invoice_dispatch_policy_verification.sql.
update public.products set inventory_tracked = false where company_id = rls_test.id('company_a');
insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Main', true), (rls_test.id('wb'), rls_test.id('company_b'), 'W1', 'B main', true);
insert into rls_test.ids (key, id)
select case warehouse_id when rls_test.id('w1') then 'g1' else 'gb' end, id
from public.inventory_locations where location_code = 'GENERAL' and warehouse_id in (rls_test.id('w1'), rls_test.id('wb'));

set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('setup: 30 wash basins in stock', 'g1', rls_test.grn(rls_test.id('a'), 30, 600));
reset role;
select rls_test.set('tx0', to_jsonb(rls_test.tx_count(rls_test.id('company_a'))));
select rls_test.set('fy', to_jsonb(private.financial_year(rls_test.today(), 4)));
select rls_test.set('fyp', to_jsonb(substr(rls_test.get('fy') ->> 0, 3, 2) || '-' || right(rls_test.get('fy') ->> 0, 2)));

-- ---------------------------------------------------------------------------
-- 1. Manual invoice: line discounts (% and amount), freight, CGST + SGST
--    A: 2 x 1000 - 10% = 1800, +162 +162 = 2124
--    B: 3 x 500 - 100 = 1400, +84 +84 = 1568
--    freight 200 at 18% = 236                         total 3928
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('manual: draft with two products and freight', 'i1',
  rls_test.save(null, jsonb_build_object('customer_id', rls_test.id('cx'), 'payment_terms_days', 15, 'notes', 'Thank you',
      'transport_details', 'VRL Logistics', 'vehicle_number', 'mh12ab1234', 'eway_bill_number', '123456789012'),
    jsonb_build_array(rls_test.ln(rls_test.id('a'), 2, '{"discount_percent": 10}'), rls_test.ln(rls_test.id('b'), 3, '{"discount_amount": 100}')),
    '{"freight": 200}'));
reset role;
select rls_test.set('i1id', to_jsonb(rls_test.gid('i1', 'invoice_id')));
select rls_test.ok('manual: line A taxable 1800, CGST 162, SGST 162, total 2124',
  (rls_test.inv_line(rls_test.gid('i1', 'invoice_id'), 1)).taxable_value = 1800 and (rls_test.inv_line(rls_test.gid('i1', 'invoice_id'), 1)).cgst_amount = 162
  and (rls_test.inv_line(rls_test.gid('i1', 'invoice_id'), 1)).sgst_amount = 162 and (rls_test.inv_line(rls_test.gid('i1', 'invoice_id'), 1)).line_total = 2124
  and (rls_test.inv_line(rls_test.gid('i1', 'invoice_id'), 1)).igst_amount = 0);
select rls_test.ok('manual: line B (amount discount) taxable 1400, total 1568; HSN from the Product Master',
  (rls_test.inv_line(rls_test.gid('i1', 'invoice_id'), 2)).taxable_value = 1400 and (rls_test.inv_line(rls_test.gid('i1', 'invoice_id'), 2)).line_total = 1568
  and (rls_test.inv_line(rls_test.gid('i1', 'invoice_id'), 2)).hsn_sac = '6910');
select rls_test.ok('manual: freight is a charge line with SAC 996511 at 18% = 236',
  (rls_test.inv_line(rls_test.gid('i1', 'invoice_id'), 3)).line_type = 'CHARGE' and (rls_test.inv_line(rls_test.gid('i1', 'invoice_id'), 3)).charge_kind = 'FREIGHT'
  and (rls_test.inv_line(rls_test.gid('i1', 'invoice_id'), 3)).hsn_sac = '996511' and (rls_test.inv_line(rls_test.gid('i1', 'invoice_id'), 3)).line_total = 236);
select rls_test.ok('manual: totals (gross 3700, discount 300, taxable 3400, CGST 264, SGST 264, grand 3928), intra-state',
  (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).gross_total = 3700 and (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).discount_total = 300
  and (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).taxable_subtotal = 3400 and (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).cgst_total = 264
  and (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).sgst_total = 264 and (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).grand_total = 3928
  and (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).tax_treatment = 'INTRA_STATE', to_jsonb(rls_test.inv(rls_test.gid('i1', 'invoice_id')))::text);
select rls_test.ok('manual: header fields kept (source MANUAL, PAN from customer, vehicle upper-cased, e-way bill, due = date + 15)',
  (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).source = 'MANUAL' and (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).customer_pan = 'AABCX1234A'
  and (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).vehicle_number = 'MH12AB1234' and (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).eway_bill_number = '123456789012'
  and (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).due_date = rls_test.today() + 15 and (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).status = 'DRAFT'
  and (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).invoice_number is null);
select rls_test.ok('manual: no blocking issues', jsonb_array_length(rls_test.get('i1') -> 'issues') = 0, rls_test.get('i1')::text);

-- Draft edit: 3 instead of 2 wash basins (total moves by 1062), billing address overridden.
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('edit draft: change quantity and billing address', 'i1e',
  rls_test.save(rls_test.gid('i1', 'invoice_id'), jsonb_build_object('billing_address', 'Site office, Wakad'),
    jsonb_build_array(rls_test.ln(rls_test.id('a'), 3, '{"discount_percent": 10}'), rls_test.ln(rls_test.id('b'), 3, '{"discount_amount": 100}')),
    '{"freight": 200}'));
reset role;
select rls_test.ok('edit draft: grand total 4990, address override kept, same invoice, payment terms kept',
  (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).grand_total = 4990 and (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).customer_billing_address = 'Site office, Wakad'
  and rls_test.gid('i1e', 'invoice_id') = rls_test.gid('i1', 'invoice_id') and (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).payment_terms_days = 15,
  to_jsonb(rls_test.inv(rls_test.gid('i1', 'invoice_id')))::text);

-- Issue: one step, no approval, official number.
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('issue: one step, no approval', 'i1i', rls_test.issue(rls_test.gid('i1', 'invoice_id')));
reset role;
select rls_test.ok('issue: number INV/<fy>/0001, status ISSUED, terms and history recorded',
  rls_test.get('i1i') ->> 'invoice_number' = 'INV/' || (rls_test.get('fyp') ->> 0) || '/0001'
  and (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).status = 'ISSUED'
  and rls_test.events(rls_test.gid('i1', 'invoice_id')) @> array['DRAFT_CREATED', 'DRAFT_UPDATED', 'ISSUED'], rls_test.get('i1i')::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('issue: an issued invoice cannot be edited',
  rls_test.save(rls_test.gid('i1', 'invoice_id'), '{}'::jsonb, jsonb_build_array(rls_test.ln(rls_test.id('a'), 1))), 'Only draft invoices');
select rls_test.expect_call_error('issue: cannot be issued twice', rls_test.issue(rls_test.gid('i1', 'invoice_id')), 'already issued');
reset role;
select rls_test.ok('issue: invoices never move stock', rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx0') ->> 0)::bigint);

-- ---------------------------------------------------------------------------
-- 2. GST engine: inter-state IGST, tax-inclusive prices, invoice discount, rounding
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('IGST: customer in Gujarat', 'i2', rls_test.save(null, jsonb_build_object('customer_id', rls_test.id('cy')),
  jsonb_build_array(rls_test.ln(rls_test.id('a'), 1))));
select rls_test.expect_call_ok('inclusive: 1 wash basin at 1180 incl. GST', 'i3', rls_test.save(null,
  jsonb_build_object('customer_id', rls_test.id('cx'), 'pricing_mode', 'INCLUSIVE'), jsonb_build_array(rls_test.ln(rls_test.id('a'), 1, '{"unit_price": 1180}'))));
select rls_test.expect_call_ok('invoice discount: 150 off 1000 + 500', 'i4', rls_test.save(null,
  jsonb_build_object('customer_id', rls_test.id('cx'), 'invoice_discount_amount', 150),
  jsonb_build_array(rls_test.ln(rls_test.id('a'), 1), rls_test.ln(rls_test.id('b'), 1))));
select rls_test.expect_call_error('invoice discount: percentage and amount together refused', rls_test.save(null,
  jsonb_build_object('customer_id', rls_test.id('cx'), 'invoice_discount_amount', 10, 'invoice_discount_percent', 5),
  jsonb_build_array(rls_test.ln(rls_test.id('a'), 1))), 'not both');
reset role;
select rls_test.ok('IGST: 18% IGST = 180, no CGST/SGST, total 1180, inter-state, place of supply 24',
  (rls_test.inv(rls_test.gid('i2', 'invoice_id'))).igst_total = 180 and (rls_test.inv(rls_test.gid('i2', 'invoice_id'))).cgst_total = 0
  and (rls_test.inv(rls_test.gid('i2', 'invoice_id'))).grand_total = 1180 and (rls_test.inv(rls_test.gid('i2', 'invoice_id'))).tax_treatment = 'INTER_STATE'
  and (rls_test.inv(rls_test.gid('i2', 'invoice_id'))).place_of_supply_state_code = '24');
select rls_test.ok('inclusive: taxable 1000.00, CGST 90, SGST 90, total stays 1180',
  (rls_test.inv_line(rls_test.gid('i3', 'invoice_id'), 1)).taxable_value = 1000 and (rls_test.inv_line(rls_test.gid('i3', 'invoice_id'), 1)).cgst_amount = 90
  and (rls_test.inv_line(rls_test.gid('i3', 'invoice_id'), 1)).sgst_amount = 90 and (rls_test.inv(rls_test.gid('i3', 'invoice_id'))).grand_total = 1180
  and (rls_test.inv(rls_test.gid('i3', 'invoice_id'))).pricing_mode = 'INCLUSIVE');
select rls_test.ok('invoice discount: shared 100 / 50 by value; taxable 900 + 450; total 1062 + 504 = 1566',
  (rls_test.inv_line(rls_test.gid('i4', 'invoice_id'), 1)).invoice_discount_share = 100 and (rls_test.inv_line(rls_test.gid('i4', 'invoice_id'), 2)).invoice_discount_share = 50
  and (rls_test.inv_line(rls_test.gid('i4', 'invoice_id'), 1)).taxable_value = 900 and (rls_test.inv_line(rls_test.gid('i4', 'invoice_id'), 2)).taxable_value = 450
  and (rls_test.inv(rls_test.gid('i4', 'invoice_id'))).grand_total = 1566 and (rls_test.inv(rls_test.gid('i4', 'invoice_id'))).invoice_discount_total = 150
  and (rls_test.inv(rls_test.gid('i4', 'invoice_id'))).discount_total = 150);

-- Rounding: 999.99 + 18% IGST = 1179.99 -> UP 1180 (+0.01), DOWN 1179 (-0.99), NEAREST 1180.
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('rounding: enable round-off, mode UP', 'st1', 'select public.billing_settings_update(''{"round_off_enabled": true, "rounding_mode": "UP"}''::jsonb)');
select rls_test.expect_call_ok('rounding: draft at 999.99', 'i5', rls_test.save(null, jsonb_build_object('customer_id', rls_test.id('cy')),
  jsonb_build_array(rls_test.ln(rls_test.id('a'), 1, '{"unit_price": 999.99}'))));
reset role;
select rls_test.ok('rounding UP: 1179.99 -> 1180.00, round-off +0.01',
  (rls_test.inv(rls_test.gid('i5', 'invoice_id'))).grand_total = 1180 and (rls_test.inv(rls_test.gid('i5', 'invoice_id'))).round_off = 0.01,
  to_jsonb(rls_test.inv(rls_test.gid('i5', 'invoice_id')))::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.call('select public.billing_settings_update(''{"rounding_mode": "DOWN"}''::jsonb)');
select rls_test.call(rls_test.save(rls_test.gid('i5', 'invoice_id'), '{}'::jsonb, jsonb_build_array(rls_test.ln(rls_test.id('a'), 1, '{"unit_price": 999.99}'))));
reset role;
select rls_test.ok('rounding DOWN: 1179.00, round-off -0.99',
  (rls_test.inv(rls_test.gid('i5', 'invoice_id'))).grand_total = 1179 and (rls_test.inv(rls_test.gid('i5', 'invoice_id'))).round_off = -0.99);
set local role authenticated;
select rls_test.claims('op');
select rls_test.call('select public.billing_settings_update(''{"round_off_enabled": false, "rounding_mode": "NEAREST"}''::jsonb)');
select rls_test.call(format('select public.sales_invoice_action(%L, ''DISCARD'')', rls_test.gid('i5', 'invoice_id')));
reset role;

-- ---------------------------------------------------------------------------
-- 3. Validation
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('validation: e-way bill must have 12 digits', rls_test.save(null,
  jsonb_build_object('customer_id', rls_test.id('cx'), 'eway_bill_number', '12345'), jsonb_build_array(rls_test.ln(rls_test.id('a'), 1))), '12 digits');
select rls_test.expect_call_error('validation: invalid GSTIN override', rls_test.save(null,
  jsonb_build_object('customer_id', rls_test.id('cx'), 'customer_gstin', '27ABC'), jsonb_build_array(rls_test.ln(rls_test.id('a'), 1))), 'not a valid GSTIN');
select rls_test.expect_call_error('validation: zero quantity', rls_test.save(null,
  jsonb_build_object('customer_id', rls_test.id('cx')), jsonb_build_array(rls_test.ln(rls_test.id('a'), 0))), 'greater than zero');
select rls_test.expect_call_error('validation: pieces are whole numbers', rls_test.save(null,
  jsonb_build_object('customer_id', rls_test.id('cx')), jsonb_build_array(rls_test.ln(rls_test.id('a'), 1.5))), 'whole pieces');
select rls_test.expect_call_ok('validation: KG may be fractional', 'ikg', rls_test.save(null,
  jsonb_build_object('customer_id', rls_test.id('cx')), jsonb_build_array(rls_test.ln(rls_test.id('kg'), 2.5))));
select rls_test.expect_call_error('validation: unit must match the product', rls_test.save(null,
  jsonb_build_object('customer_id', rls_test.id('cx')), jsonb_build_array(rls_test.ln(rls_test.id('a'), 1, '{"unit": "BOX"}'))), 'does not match');
select rls_test.expect_call_error('validation: inactive customer', rls_test.save(null,
  jsonb_build_object('customer_id', rls_test.id('cz')), jsonb_build_array(rls_test.ln(rls_test.id('a'), 1))), 'inactive');
select rls_test.expect_call_error('validation: due date before invoice date', rls_test.save(null,
  jsonb_build_object('customer_id', rls_test.id('cx'), 'due_date', rls_test.today() - 1), jsonb_build_array(rls_test.ln(rls_test.id('a'), 1))), 'due date');
select rls_test.expect_call_error('validation: no products', rls_test.save(null, jsonb_build_object('customer_id', rls_test.id('cx')), '[]'::jsonb), 'between 1 and 500');
select rls_test.expect_call_ok('validation: future-dated draft is saved', 'ifut', rls_test.save(null,
  jsonb_build_object('customer_id', rls_test.id('cx'), 'invoice_date', rls_test.today() + 5), jsonb_build_array(rls_test.ln(rls_test.id('a'), 1))));
select rls_test.expect_call_error('validation: ... but cannot be issued', rls_test.issue(rls_test.gid('ifut', 'invoice_id')), 'future');
reset role;
select rls_test.ok('validation: KG line 2.5 x 200 at 5% = 525', (rls_test.inv(rls_test.gid('ikg', 'invoice_id'))).grand_total = 525);

-- ---------------------------------------------------------------------------
-- 4. Sales-order invoicing: partial (3 + 4 + 3), no over-invoicing, proforma
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('SO: order for 10 pedestals at 450 (5% discount)', 'so1',
  format('select public.sales_order_v2_save(null, %L::jsonb, %L::jsonb, %L)', jsonb_build_object('customer_id', rls_test.id('cx'), 'customer_po_number', 'PO-77'),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('b'), 'quantity', 10, 'unit_price', 450, 'discount_percent', 5)), gen_random_uuid()));
select rls_test.expect_call_ok('SO: invoiceable lines', 'sl0', format('select public.sales_order_invoice_lines(%L)', rls_test.gid('so1', 'sales_order_id')));
reset role;
select rls_test.set('sol1', to_jsonb((rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('b'))).id));
select rls_test.ok('SO: 10 ordered, 0 invoiced, 10 pending; price 450, 5% discount, GST 12, HSN 6910',
  (rls_test.so_line(rls_test.get('sl0'), 'IV-B') ->> 'pending')::numeric = 10 and (rls_test.so_line(rls_test.get('sl0'), 'IV-B') ->> 'invoiced')::numeric = 0
  and (rls_test.so_line(rls_test.get('sl0'), 'IV-B') ->> 'unit_price')::numeric = 450 and (rls_test.so_line(rls_test.get('sl0'), 'IV-B') ->> 'discount_percent')::numeric = 5
  and (rls_test.so_line(rls_test.get('sl0'), 'IV-B') ->> 'gst_rate')::numeric = 12 and rls_test.so_line(rls_test.get('sl0'), 'IV-B') ->> 'hsn_code' = '6910',
  rls_test.get('sl0')::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('SO: first invoice for 3', 'is1', rls_test.save(null, jsonb_build_object('sales_order_id', rls_test.gid('so1', 'sales_order_id')),
  jsonb_build_array(rls_test.ln(rls_test.id('b'), 3, jsonb_build_object('sales_order_line_id', rls_test.get('sol1') ->> 0)))));
select rls_test.expect_call_ok('SO: issue it', 'is1i', rls_test.issue(rls_test.gid('is1', 'invoice_id')));
select rls_test.expect_call_ok('SO: second invoice (draft) for 4', 'is2', rls_test.save(null, jsonb_build_object('sales_order_id', rls_test.gid('so1', 'sales_order_id')),
  jsonb_build_array(rls_test.ln(rls_test.id('b'), 4, jsonb_build_object('sales_order_line_id', rls_test.get('sol1') ->> 0)))));
select rls_test.expect_call_error('SO: 4 more is refused (only 3 left; drafts count)', rls_test.save(null, jsonb_build_object('sales_order_id', rls_test.gid('so1', 'sales_order_id')),
  jsonb_build_array(rls_test.ln(rls_test.id('b'), 4, jsonb_build_object('sales_order_line_id', rls_test.get('sol1') ->> 0)))), 'only 3');
select rls_test.expect_call_error('SO: another customer is refused', rls_test.save(null,
  jsonb_build_object('sales_order_id', rls_test.gid('so1', 'sales_order_id'), 'customer_id', rls_test.id('cy')),
  jsonb_build_array(rls_test.ln(rls_test.id('b'), 1, jsonb_build_object('sales_order_line_id', rls_test.get('sol1') ->> 0)))), 'another customer');
select rls_test.expect_call_error('SO: product must match the order line', rls_test.save(null, jsonb_build_object('sales_order_id', rls_test.gid('so1', 'sales_order_id')),
  jsonb_build_array(rls_test.ln(rls_test.id('a'), 1, jsonb_build_object('sales_order_line_id', rls_test.get('sol1') ->> 0)))), 'differs');
select rls_test.expect_call_ok('SO: proforma for all 10 is allowed (not counted)', 'ipf', rls_test.save(null,
  jsonb_build_object('sales_order_id', rls_test.gid('so1', 'sales_order_id'), 'is_proforma', true),
  jsonb_build_array(rls_test.ln(rls_test.id('b'), 10, jsonb_build_object('sales_order_line_id', rls_test.get('sol1') ->> 0)))));
select rls_test.expect_call_ok('SO: third invoice for the last 3', 'is3', rls_test.save(null, jsonb_build_object('sales_order_id', rls_test.gid('so1', 'sales_order_id')),
  jsonb_build_array(rls_test.ln(rls_test.id('b'), 3, jsonb_build_object('sales_order_line_id', rls_test.get('sol1') ->> 0)))));
select rls_test.expect_call_ok('SO: issue the second', 'is2i', rls_test.issue(rls_test.gid('is2', 'invoice_id')));
select rls_test.expect_call_ok('SO: issue the third', 'is3i', rls_test.issue(rls_test.gid('is3', 'invoice_id')));
select rls_test.expect_call_ok('SO: invoiceable lines after 3 + 4 + 3', 'sl1', format('select public.sales_order_invoice_lines(%L)', rls_test.gid('so1', 'sales_order_id')));
reset role;
select rls_test.ok('SO: prices from the order (3 x 450 - 5% = 1282.50 taxable), linked to the order, source SALES_ORDER',
  (rls_test.inv_line(rls_test.gid('is1', 'invoice_id'), 1)).unit_price = 450 and (rls_test.inv_line(rls_test.gid('is1', 'invoice_id'), 1)).taxable_value = 1282.50
  and (rls_test.inv(rls_test.gid('is1', 'invoice_id'))).sales_order_id = rls_test.gid('so1', 'sales_order_id')
  and (rls_test.inv(rls_test.gid('is1', 'invoice_id'))).source = 'SALES_ORDER'
  and (rls_test.inv(rls_test.gid('is1', 'invoice_id'))).order_references like '%PO-77%');
select rls_test.ok('SO: fully invoiced (10 invoiced, 0 pending) over three invoices',
  (rls_test.so_line(rls_test.get('sl1'), 'IV-B') ->> 'invoiced')::numeric = 10 and (rls_test.so_line(rls_test.get('sl1'), 'IV-B') ->> 'pending')::numeric = 0,
  rls_test.get('sl1')::text);
select rls_test.ok('proforma: own PFI number, still a draft, no invoice number',
  (rls_test.inv(rls_test.gid('ipf', 'invoice_id'))).proforma_number like 'PFI%' and (rls_test.inv(rls_test.gid('ipf', 'invoice_id'))).is_proforma
  and (rls_test.inv(rls_test.gid('ipf', 'invoice_id'))).invoice_number is null, to_jsonb(rls_test.inv(rls_test.gid('ipf', 'invoice_id')))::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('proforma: never issued as a tax invoice by accident', rls_test.issue(rls_test.gid('ipf', 'invoice_id')), 'proforma');
select rls_test.expect_call_error('proforma: converting is checked against the order (nothing left)', rls_test.issue(rls_test.gid('ipf', 'invoice_id'), true), 'still to be invoiced');
select rls_test.expect_call_ok('proforma: manual proforma', 'ipf2', rls_test.save(null, jsonb_build_object('customer_id', rls_test.id('cx'), 'is_proforma', true),
  jsonb_build_array(rls_test.ln(rls_test.id('a'), 1))));
select rls_test.expect_call_ok('proforma: convert and issue', 'ipf2i', rls_test.issue(rls_test.gid('ipf2', 'invoice_id'), true));
reset role;
select rls_test.ok('proforma: converted invoice keeps its PFI reference and gets the next INV number',
  not (rls_test.inv(rls_test.gid('ipf2', 'invoice_id'))).is_proforma and (rls_test.inv(rls_test.gid('ipf2', 'invoice_id'))).status = 'ISSUED'
  and (rls_test.inv(rls_test.gid('ipf2', 'invoice_id'))).proforma_number like 'PFI%' and rls_test.get('ipf2i') ->> 'invoice_number' like 'INV/%'
  and rls_test.events(rls_test.gid('ipf2', 'invoice_id')) @> array['PROFORMA_CONVERTED'], rls_test.get('ipf2i')::text);

-- Dispatch invoicing cannot bill what was already invoiced from the order.
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('dispatch cap: order for 5 wash basins (reserved from stock)', 'so2',
  format('select public.sales_order_v2_save(null, %L::jsonb, %L::jsonb, %L)', jsonb_build_object('customer_id', rls_test.id('cx')),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('a'), 'quantity', 5)), gen_random_uuid()));
reset role;
select rls_test.set('sol2', to_jsonb((rls_test.sol(rls_test.gid('so2', 'sales_order_id'), rls_test.id('a'))).id));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('dispatch cap: dispatch all 5', 'd2', format('select public.sales_order_v2_dispatch(%L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('so2', 'sales_order_id'),
  jsonb_build_array(jsonb_build_object('line_id', rls_test.get('sol2') ->> 0, 'quantity', 5)), '{}'::jsonb, gen_random_uuid()));
select rls_test.expect_call_ok('dispatch cap: invoice 2 from the order', 'is4', rls_test.save(null, jsonb_build_object('sales_order_id', rls_test.gid('so2', 'sales_order_id')),
  jsonb_build_array(rls_test.ln(rls_test.id('a'), 2, jsonb_build_object('sales_order_line_id', rls_test.get('sol2') ->> 0)))));
select rls_test.expect_call_ok('dispatch cap: issue it', 'is4i', rls_test.issue(rls_test.gid('is4', 'invoice_id')));
reset role;
select rls_test.ok('dispatch cap: only 3 of the 5 dispatched are still invoiceable from the dispatch', rls_test.dispatch_left((rls_test.get('sol2') ->> 0)::uuid) = 3,
  rls_test.dispatch_left((rls_test.get('sol2') ->> 0)::uuid)::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('dispatch cap: dispatch invoice for the remaining 3', 'id1', format('select public.sales_invoice_create_draft(%L::jsonb, ''{}''::jsonb, %L)',
  jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.fl((rls_test.get('sol2') ->> 0)::uuid))), gen_random_uuid()));
reset role;
select rls_test.ok('dispatch cap: the dispatch invoice takes exactly 3 (dispatch invoices still work as before)',
  (rls_test.inv_line(rls_test.gid('id1', 'invoice_id'), 1)).quantity = 3 and (rls_test.inv(rls_test.gid('id1', 'invoice_id'))).source = 'DISPATCH'
  and (rls_test.inv(rls_test.gid('id1', 'invoice_id'))).grand_total = 3540, to_jsonb(rls_test.inv_line(rls_test.gid('id1', 'invoice_id'), 1))::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('dispatch cap: an order invoice cannot add more on top', rls_test.save(null, jsonb_build_object('sales_order_id', rls_test.gid('so2', 'sales_order_id')),
  jsonb_build_array(rls_test.ln(rls_test.id('a'), 1, jsonb_build_object('sales_order_line_id', rls_test.get('sol2') ->> 0)))), 'only 0');
select rls_test.expect_call_error('dispatch drafts are edited on the dispatch screen', rls_test.save(rls_test.gid('id1', 'invoice_id'), '{}'::jsonb,
  jsonb_build_array(rls_test.ln(rls_test.id('a'), 1))), 'dispatch');
reset role;

-- ---------------------------------------------------------------------------
-- 5. Payments: partial, multiple, duplicates, excess advance, apply, reversal
--    Invoice 1 total 4990
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('payment: 1000 by UPI', 'p1', rls_test.pay(rls_test.gid('i1', 'invoice_id'), '{"amount": 1000, "payment_method": "UPI"}'));
reset role;
select rls_test.ok('payment: balance 3990, partially paid',
  rls_test.balance(rls_test.gid('i1', 'invoice_id')) = 3990 and rls_test.list(rls_test.gid('i1', 'invoice_id')) ->> 'payment_status' = 'PARTIALLY_PAID'
  and (rls_test.get('p1') ->> 'allocated')::numeric = 1000);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('payment: same amount, day and method without reference looks like a double entry',
  rls_test.pay(rls_test.gid('i1', 'invoice_id'), '{"amount": 1000, "payment_method": "UPI"}'), 'already records');
select rls_test.expect_call_ok('payment: confirmed as a separate payment', 'p1b',
  rls_test.pay(rls_test.gid('i1', 'invoice_id'), '{"amount": 1000, "payment_method": "UPI", "confirm_duplicate": true}'));
select rls_test.expect_call_ok('payment: 2000 by bank with UTR', 'p2',
  rls_test.pay(rls_test.gid('i1', 'invoice_id'), '{"amount": 2000, "payment_method": "BANK_TRANSFER", "transaction_reference": "UTR-1", "bank_reference": "HDFC 0012"}'));
select rls_test.expect_call_error('payment: the same UTR twice is refused',
  rls_test.pay(rls_test.gid('i1', 'invoice_id'), '{"amount": 10, "payment_method": "BANK_TRANSFER", "transaction_reference": "utr-1"}'), 'already recorded');
select rls_test.expect_call_error('payment: zero amount refused', rls_test.pay(rls_test.gid('i1', 'invoice_id'), '{"amount": 0, "payment_method": "CASH"}'), 'greater than zero');
select rls_test.expect_call_error('payment: method must be enabled', rls_test.pay(rls_test.gid('i1', 'invoice_id'), '{"amount": 5, "payment_method": "CARD"}'), 'not enabled');
select rls_test.expect_call_error('payment: only on issued invoices', rls_test.pay(rls_test.gid('i4', 'invoice_id'), '{"amount": 5, "payment_method": "CASH"}'), 'issued invoices');
select rls_test.expect_call_ok('payment: 1100 more (balance 990) -> 110 kept as advance', 'p3',
  rls_test.pay(rls_test.gid('i1', 'invoice_id'), '{"amount": 1100, "payment_method": "CASH"}'));
reset role;
select rls_test.ok('payment: paid in full; 990 allocated, 110 advance with a warning',
  rls_test.balance(rls_test.gid('i1', 'invoice_id')) = 0 and rls_test.list(rls_test.gid('i1', 'invoice_id')) ->> 'payment_status' = 'PAID'
  and (rls_test.get('p3') ->> 'allocated')::numeric = 990 and (rls_test.get('p3') ->> 'advance')::numeric = 110
  and jsonb_array_length(rls_test.get('p3') -> 'warnings') = 1, rls_test.get('p3')::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('payment: nothing more on a paid invoice', rls_test.pay(rls_test.gid('i1', 'invoice_id'), '{"amount": 5, "payment_method": "CASH"}'), 'fully paid');
select rls_test.expect_call_ok('advance: issue the 1180 inclusive invoice', 'i3i', rls_test.issue(rls_test.gid('i3', 'invoice_id')));
select rls_test.expect_call_ok('advance: apply the 110 advance to it', 'adv',
  format('select public.invoice_v2_apply_advance(%L, %L, null, %L)', rls_test.gid('i3', 'invoice_id'), rls_test.gid('p3', 'payment_id'), gen_random_uuid()));
select rls_test.expect_call_error('advance: nothing left to apply', format('select public.invoice_v2_apply_advance(%L, %L, null, %L)',
  rls_test.gid('i3', 'invoice_id'), rls_test.gid('p3', 'payment_id'), gen_random_uuid()), 'Nothing to apply');
reset role;
select rls_test.ok('advance: applied 110; invoice balance 1070; receipt fully used',
  (rls_test.get('adv') ->> 'applied')::numeric = 110 and rls_test.balance(rls_test.gid('i3', 'invoice_id')) = 1070 and (rls_test.get('adv') ->> 'unallocated')::numeric = 0,
  rls_test.get('adv')::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('reversal: reverse the 2000 bank receipt', 'rv',
  format('select public.customer_payment_reverse(%L, ''Cheque bounced / wrong entry'', %L)', rls_test.gid('p2', 'payment_id'), gen_random_uuid()));
reset role;
select rls_test.ok('reversal: outstanding = total - valid payments (4990 - 2990 = 2000), partially paid again',
  rls_test.balance(rls_test.gid('i1', 'invoice_id')) = 2000 and rls_test.list(rls_test.gid('i1', 'invoice_id')) ->> 'payment_status' = 'PARTIALLY_PAID');

-- ---------------------------------------------------------------------------
-- 6. Credit and debit notes (one step; original invoice unchanged)
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('IGST invoice issued', 'i2i', rls_test.issue(rls_test.gid('i2', 'invoice_id')));
select rls_test.expect_call_error('advance: another customer''s receipt cannot be applied', format('select public.invoice_v2_apply_advance(%L, %L, 1, %L)',
  rls_test.gid('i2', 'invoice_id'), rls_test.gid('p1', 'payment_id'), gen_random_uuid()), 'another customer');
select rls_test.expect_call_ok('credit note: price correction of 100 (review point confirmed in one step)', 'cn',
  format('select public.adjustment_note_v2_issue(%L, ''CREDIT'', %L::jsonb, %L::jsonb, %L)', rls_test.gid('i2', 'invoice_id'),
    '{"reason_code": "PRICE_CORRECTION", "reason": "Agreed rate revision"}',
    jsonb_build_array(jsonb_build_object('invoice_line_id', (rls_test.inv_line(rls_test.gid('i2', 'invoice_id'), 1)).id, 'taxable_amount', 100)), gen_random_uuid()));
select rls_test.expect_call_ok('debit note: additional charge of 50', 'dn',
  format('select public.adjustment_note_v2_issue(%L, ''DEBIT'', %L::jsonb, %L::jsonb, %L)', rls_test.gid('i2', 'invoice_id'),
    '{"reason_code": "ADDITIONAL_CHARGE", "reason": "Extra loading charges"}',
    jsonb_build_array(jsonb_build_object('invoice_line_id', (rls_test.inv_line(rls_test.gid('i2', 'invoice_id'), 1)).id, 'taxable_amount', 50)), gen_random_uuid()));
select rls_test.expect_call_error('credit note: only on issued invoices', format('select public.adjustment_note_v2_issue(%L, ''CREDIT'', %L::jsonb, %L::jsonb, %L)',
  rls_test.gid('i4', 'invoice_id'), '{"reason_code": "OTHER", "reason": "test"}',
  jsonb_build_array(jsonb_build_object('invoice_line_id', (rls_test.inv_line(rls_test.gid('i4', 'invoice_id'), 1)).id, 'taxable_amount', 1)), gen_random_uuid()), 'issued invoice');
reset role;
select rls_test.ok('notes: CN/… total 118 (IGST), DN/… total 59; balance 1180 - 118 + 59 = 1121; invoice total unchanged',
  rls_test.get('cn') ->> 'note_number' like 'CN/%' and (rls_test.get('cn') ->> 'total')::numeric = 118
  and rls_test.get('dn') ->> 'note_number' like 'DN/%' and (rls_test.get('dn') ->> 'total')::numeric = 59
  and rls_test.balance(rls_test.gid('i2', 'invoice_id')) = 1121 and (rls_test.inv(rls_test.gid('i2', 'invoice_id'))).grand_total = 1180,
  rls_test.get('cn')::text || rls_test.get('dn')::text);

-- ---------------------------------------------------------------------------
-- 7. Cancellation: numbers are never reused
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('cancel: issue the invoice-discount invoice', 'i4i', rls_test.issue(rls_test.gid('i4', 'invoice_id')));
select rls_test.expect_call_ok('cancel: cancel it', 'i4c', format('select public.sales_invoice_action(%L, ''CANCEL'', ''Wrong customer selected'')', rls_test.gid('i4', 'invoice_id')));
select rls_test.expect_call_error('cancel: invoices with payments must have them reversed first',
  format('select public.sales_invoice_action(%L, ''CANCEL'', ''Wrong customer selected'')', rls_test.gid('i1', 'invoice_id')), 'payment allocation');
select rls_test.expect_call_ok('cancel: next invoice', 'i6', rls_test.save(null, jsonb_build_object('customer_id', rls_test.id('cx')), jsonb_build_array(rls_test.ln(rls_test.id('a'), 1))));
select rls_test.expect_call_ok('cancel: issue it', 'i6i', rls_test.issue(rls_test.gid('i6', 'invoice_id')));
reset role;
select rls_test.ok('cancel: cancelled invoice keeps its number; the next one gets a new number',
  (rls_test.inv(rls_test.gid('i4', 'invoice_id'))).status = 'CANCELLED' and rls_test.get('i6i') ->> 'invoice_number' > rls_test.get('i4i') ->> 'invoice_number'
  and (select count(*) from public.sales_invoices where company_id = rls_test.id('company_a') and invoice_number = rls_test.get('i4i') ->> 'invoice_number') = 1,
  rls_test.get('i4i')::text || rls_test.get('i6i')::text);

-- ---------------------------------------------------------------------------
-- 8. Excel import
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.set('rows', jsonb_build_array(
  jsonb_build_object('row_number', 2, 'invoice_number', 'OLD-1001', 'invoice_date', (rls_test.today() - 10)::text, 'customer_name', 'xylo homes', 'sku', 'IV-A', 'quantity', '2', 'rate', '950', 'discount', '10', 'gst_rate', '18', 'payment_terms', '30 days', 'remarks', 'Old ledger'),
  jsonb_build_object('row_number', 3, 'invoice_number', 'OLD-1001', 'invoice_date', (rls_test.today() - 10)::text, 'customer_name', 'Xylo Homes', 'sku', 'iv-b', 'quantity', '1', 'rate', '', 'gst_rate', ''),
  jsonb_build_object('row_number', 4, 'invoice_number', 'OLD-1002', 'invoice_date', (rls_test.today() - 5)::text, 'customer_gstin', '24AABCY1234A1Z5', 'sku', 'IV-A', 'quantity', '1', 'rate', '1000', 'gst_rate', '18', 'place_of_supply', 'Gujarat'),
  jsonb_build_object('row_number', 5, 'invoice_number', 'OLD-1003', 'invoice_date', (rls_test.today() - 5)::text, 'customer_name', 'Xylo Homes', 'sku', 'NOPE-9', 'quantity', '1', 'rate', '10', 'gst_rate', '18'),
  jsonb_build_object('row_number', 6, 'invoice_number', 'OLD-1004', 'invoice_date', 'yesterday', 'customer_name', 'Unknown Co', 'sku', 'IV-A', 'quantity', '1.5', 'rate', 'abc', 'gst_rate', '18'),
  jsonb_build_object('row_number', 7, 'invoice_number', 'OLD-1005', 'invoice_date', (rls_test.today() - 5)::text, 'customer_name', 'Xylo Homes', 'sales_order_number', '__SO1__', 'sku', 'IV-B', 'quantity', '1', 'rate', '450', 'gst_rate', '7'),
  jsonb_build_object('row_number', 8, 'invoice_number', 'INV/' || (rls_test.get('fyp') ->> 0) || '/0050', 'invoice_date', (rls_test.today() - 1)::text, 'customer_name', 'Xylo Homes', 'sku', 'IV-A', 'quantity', '1', 'rate', '1000', 'gst_rate', '18')));
reset role;
select rls_test.set('rows', replace((rls_test.get('rows'))::text, '__SO1__', (select sales_order_number from public.sales_orders where id = rls_test.gid('so1', 'sales_order_id')))::jsonb);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('import: preview', 'ip', format('select public.invoice_import_preview(%L::jsonb)', rls_test.get('rows')));
reset role;
select rls_test.ok('import preview: 6 invoices from 7 rows; 3 importable (1 with a warning), 3 held back',
  jsonb_array_length(rls_test.get('ip') -> 'invoices') = 6 and (rls_test.get('ip') ->> 'valid')::int + (rls_test.get('ip') ->> 'warnings')::int = 3
  and (rls_test.get('ip') ->> 'errors')::int = 3, rls_test.get('ip')::text);
select rls_test.ok('import preview: rows grouped by invoice number; rate and GST taken from the Product Master with a warning',
  (select jsonb_array_length(g -> 'rows') from jsonb_array_elements(rls_test.get('ip') -> 'invoices') g where g ->> 'invoice_number' = 'OLD-1001') = 2
  and (select g ->> 'status' from jsonb_array_elements(rls_test.get('ip') -> 'invoices') g where g ->> 'invoice_number' = 'OLD-1001') = 'WARNING');
select rls_test.ok('import preview: unknown SKU, bad date / quantity / rate / customer and over-invoiced sales order reported',
  (select g -> 'rows' -> 0 -> 'errors' ->> 0 from jsonb_array_elements(rls_test.get('ip') -> 'invoices') g where g ->> 'invoice_number' = 'OLD-1003') like '%NOPE-9%not found%'
  and (select jsonb_array_length(g -> 'rows' -> 0 -> 'errors') from jsonb_array_elements(rls_test.get('ip') -> 'invoices') g where g ->> 'invoice_number' = 'OLD-1004') >= 4
  and (select (g -> 'rows' -> 0 -> 'errors')::text from jsonb_array_elements(rls_test.get('ip') -> 'invoices') g where g ->> 'invoice_number' = 'OLD-1005') like '%left to invoice%'
  and (select (g -> 'rows' -> 0 -> 'warnings')::text from jsonb_array_elements(rls_test.get('ip') -> 'invoices') g where g ->> 'invoice_number' = 'OLD-1005') like '%not one of the configured rates%'
  and rls_test.get('ip') -> 'missing_products' @> '[{"sku": "NOPE-9"}]', rls_test.get('ip')::text);
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('import: run', 'im', format('select public.invoice_import(%L::jsonb, %L::jsonb, %L)', rls_test.get('rows'), '{"file_name": "old-invoices.xlsx"}', gen_random_uuid()));
reset role;
select rls_test.ok('import: 3 invoices issued with their own numbers, 3 not imported (none skipped silently)',
  (rls_test.get('im') ->> 'created_count')::int = 3 and (rls_test.get('im') ->> 'failed_count')::int = 3
  and (rls_test.inv_by_number(rls_test.id('company_a'), 'OLD-1001')).status = 'ISSUED'
  and (rls_test.inv_by_number(rls_test.id('company_a'), 'OLD-1001')).source = 'IMPORT', rls_test.get('im')::text);
select rls_test.ok('import: OLD-1001 = 2 x 950 - 10% (1710 + 18%) + 1 x 500 (+12%) = 2017.80 + 560 = 2577.80, terms 30 days, remarks kept',
  (rls_test.inv_by_number(rls_test.id('company_a'), 'OLD-1001')).grand_total = 2577.80
  and (rls_test.inv_by_number(rls_test.id('company_a'), 'OLD-1001')).payment_terms_days = 30
  and (rls_test.inv_by_number(rls_test.id('company_a'), 'OLD-1001')).notes = 'Old ledger',
  to_jsonb(rls_test.inv_by_number(rls_test.id('company_a'), 'OLD-1001'))::text);
select rls_test.ok('import: OLD-1002 matched by GSTIN, place of supply by state name (24), IGST',
  (rls_test.inv_by_number(rls_test.id('company_a'), 'OLD-1002')).customer_id = rls_test.id('cy')
  and (rls_test.inv_by_number(rls_test.id('company_a'), 'OLD-1002')).place_of_supply_state_code = '24'
  and (rls_test.inv_by_number(rls_test.id('company_a'), 'OLD-1002')).igst_total = 180);
select rls_test.ok('import: Bulk Operations record (type INVOICE, 7 rows: 4 imported, 3 failed)',
  (rls_test.job(rls_test.gid('im', 'job_id'))).import_type = 'INVOICE' and (rls_test.job(rls_test.gid('im', 'job_id'))).total_rows = 7
  and (rls_test.job(rls_test.gid('im', 'job_id'))).success_rows = 4 and (rls_test.job(rls_test.gid('im', 'job_id'))).failed_rows = 3,
  to_jsonb(rls_test.job(rls_test.gid('im', 'job_id')))::text);
select rls_test.set('cnt_before', to_jsonb(rls_test.inv_count(rls_test.id('company_a'))));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('import: the same file again', 'im2', format('select public.invoice_import(%L::jsonb, %L::jsonb, %L)', rls_test.get('rows'), '{"file_name": "old-invoices.xlsx"}', gen_random_uuid()));
select rls_test.expect_call_ok('import: an imported number in our own series moves the counter', 'i7',
  rls_test.save(null, jsonb_build_object('customer_id', rls_test.id('cx')), jsonb_build_array(rls_test.ln(rls_test.id('a'), 1))));
select rls_test.expect_call_ok('import: issue', 'i7i', rls_test.issue(rls_test.gid('i7', 'invoice_id')));
reset role;
select rls_test.ok('import: re-upload creates nothing; each existing number is reported',
  (rls_test.get('im2') ->> 'created_count')::int = 0 and (rls_test.get('im2') ->> 'failed_count')::int = 6
  and rls_test.inv_count(rls_test.id('company_a')) = (rls_test.get('cnt_before') ->> 0)::bigint + 1 -- + the one invoice made after it
  and (rls_test.get('im2') -> 'failed')::text like '%already exists%', rls_test.get('im2')::text);
select rls_test.ok('import: next generated number is 0051 (after the imported 0050)',
  rls_test.get('i7i') ->> 'invoice_number' = 'INV/' || (rls_test.get('fyp') ->> 0) || '/0051', rls_test.get('i7i')::text);

-- ---------------------------------------------------------------------------
-- 9. Dashboard, settings, reconciliation, isolation, grants
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('dashboard', 'db', format('select public.invoice_dashboard(%L, %L)', rls_test.today() - 60, rls_test.today()));
select rls_test.expect_call_ok('dashboard: filtered to customer Y', 'dby', format('select public.invoice_dashboard(%L, %L, %L)', rls_test.today() - 60, rls_test.today(), rls_test.id('cy')));
select rls_test.expect_call_ok('dashboard: drafts only', 'dbd', format('select public.invoice_dashboard(%L, %L, null, ''DRAFT'')', rls_test.today() - 60, rls_test.today()));
select rls_test.expect_call_error('dashboard: invalid range', format('select public.invoice_dashboard(%L, %L)', rls_test.today(), rls_test.today() - 1), 'date range');
reset role;
select rls_test.ok('dashboard: issued value equals the register; one cancelled; GST summary by rate; 12 months of trend',
  (rls_test.get('db') ->> 'total_value')::numeric = (select sum(grand_total) from public.sales_invoices where company_id = rls_test.id('company_a') and status = 'ISSUED')
  and (rls_test.get('db') ->> 'cancelled')::int = 1 and jsonb_array_length(rls_test.get('db') -> 'monthly') = 12
  and (select count(*) from jsonb_array_elements(rls_test.get('db') -> 'gst_summary') g where (g ->> 'gst_rate')::numeric in (12, 18)) = 2
  and (rls_test.get('db') ->> 'partially_paid')::int >= 1 and (rls_test.get('db') ->> 'amount_received')::numeric > 0
  and (rls_test.get('db') ->> 'outstanding')::numeric > 0, rls_test.get('db')::text);
select rls_test.ok('dashboard: customer filter (Y: 2 issued) and status filter (drafts only)',
  (rls_test.get('dby') ->> 'total_invoices')::int = 2
  and (select bool_and(r ->> 'status' = 'DRAFT') from jsonb_array_elements(rls_test.get('dbd') -> 'recent') r)
  and (rls_test.get('dbd') ->> 'total_invoices')::int = 0, rls_test.get('dby')::text);

set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('settings: bank accounts, GST rates, signatory, default method', 'st2', format('select public.billing_settings_update(%L::jsonb)',
  jsonb_build_object('bank_accounts', jsonb_build_array(jsonb_build_object('label', 'HDFC current', 'bank_name', 'HDFC Bank', 'account_number', '50200012345678', 'ifsc', 'HDFC0000123')),
    'gst_rates', array[0, 3, 5, 12, 18, 28], 'authorized_signatory', 'Director', 'default_payment_method', 'UPI')));
select rls_test.expect_call_error('settings: invalid IFSC refused', format('select public.billing_settings_update(%L::jsonb)',
  jsonb_build_object('bank_accounts', jsonb_build_array(jsonb_build_object('account_number', '50200012345678', 'ifsc', 'HDFC123')))), 'IFSC');
select rls_test.expect_call_error('settings: default method must be enabled', 'select public.billing_settings_update(''{"default_payment_method": "CARD"}''::jsonb)', 'default payment method');
reset role;
select rls_test.ok('settings: saved (3% rate added, signatory, default UPI)',
  (rls_test.get('st2') ->> 'gst_rates')::text like '%3%' and rls_test.get('st2') ->> 'authorized_signatory' = 'Director'
  and rls_test.get('st2') ->> 'default_payment_method' = 'UPI', rls_test.get('st2')::text);

select rls_test.ok('reconciliation: every balance = total - notes - valid payments; every total = lines + round-off',
  rls_test.balances_reconcile(rls_test.id('company_a')));
select rls_test.ok('stock: no inventory movement from any invoice (only the GRN and the dispatch)',
  rls_test.tx_count(rls_test.id('company_a')) > (rls_test.get('tx0') ->> 0)::bigint
  and not exists (select 1 from public.inventory_transactions t where t.company_id = rls_test.id('company_a') and t.reference_type ilike '%INVOICE%'));

set local role authenticated;
select rls_test.claims('b_op');
select rls_test.expect_call_error('isolation: company B cannot invoice company A''s customer', rls_test.save(null, jsonb_build_object('customer_id', rls_test.id('cx')),
  jsonb_build_array(rls_test.ln(rls_test.id('a'), 1))), 'customer');
select rls_test.expect_call_error('isolation: company B cannot issue company A''s invoice', rls_test.issue(rls_test.gid('i7', 'invoice_id')), 'not found');
select rls_test.expect_call_error('isolation: company B cannot pay company A''s invoice', rls_test.pay(rls_test.gid('i6', 'invoice_id'), '{"amount": 1, "payment_method": "CASH"}'), 'not found');
select rls_test.expect_call_ok('isolation: company B dashboard', 'dbb', format('select public.invoice_dashboard(%L, %L)', rls_test.today() - 60, rls_test.today()));
reset role;
select rls_test.ok('isolation: company B sees no invoices', (rls_test.get('dbb') ->> 'total_invoices')::int = 0 and (rls_test.get('dbb') ->> 'drafts')::int = 0);
select rls_test.ok('grants: anon cannot call the invoicing functions',
  not has_function_privilege('anon', 'public.sales_invoice_v2_save(uuid, jsonb, jsonb, jsonb, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.sales_invoice_v2_issue(uuid, boolean, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.invoice_v2_record_payment(uuid, jsonb, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.invoice_import(jsonb, jsonb, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.invoice_dashboard(date, date, uuid, text, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.invoice_v2_issue_core(uuid, uuid, text)', 'EXECUTE'));

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
  raise exception 'INVOICING_V2_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
