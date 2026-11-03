-- =============================================================================
-- BILLING, INVOICING & RECEIVABLES (PHASE 8) VERIFICATION
--
-- Invoices from actual dispatches only, quantity limits and duplicate
-- protection, GST calculation (intra / inter-state, rounding, charges,
-- round-off), validation of missing tax data and review items, numbering,
-- approval and segregation of duties, immutability, payments and allocations,
-- credit / debit notes (including return-linked credits), cancellation,
-- receivables ageing as of a date, statements, reports, RLS, permissions and
-- audit history.
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction with its own companies (BLA / BLB) and ALWAYS ends by
-- raising BILLING_VERIFICATION_RESULT passed=N failed=M (rolls everything back).
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

-- Owner-side probes
create function rls_test.inv(p_id uuid) returns public.sales_invoices language sql stable security definer as $$ select * from public.sales_invoices where id = p_id $$;
create function rls_test.bal(p_id uuid) returns numeric language sql stable security definer as $$ select private.invoice_balance(p_id) $$;
create function rls_test.on_hand(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(on_hand), 0) from public.inventory_balances where product_id = p_product $$;
create function rls_test.tx_count(p_company uuid) returns int language sql stable security definer as $$
  select count(*)::int from public.inventory_transactions where company_id = p_company $$;
create function rls_test.sol(p_so uuid, p_product uuid) returns uuid language sql stable security definer as $$
  select id from public.sales_order_lines where sales_order_id = p_so and product_id = p_product $$;
create function rls_test.res_of(p_line uuid) returns uuid language sql stable security definer as $$
  select id from public.stock_reservations where reference_type = 'SALES_ORDER_LINE' and reference_id = p_line
    and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') order by quantity - fulfilled_quantity - released_quantity desc limit 1 $$;
create function rls_test.fl(p_ful uuid, p_product uuid) returns uuid language sql stable security definer as $$
  select id from public.fulfilment_lines where fulfilment_id = p_ful and product_id = p_product $$;
create function rls_test.iline(p_inv uuid, p_product uuid) returns uuid language sql stable security definer as $$
  select id from public.sales_invoice_lines where invoice_id = p_inv and product_id = p_product $$;
create function rls_test.inv_seq() returns bigint language sql stable security definer as $$
  select last_value from public.billing_number_sequences where company_id = (select id from rls_test.ids where key = 'company_a') and scope like 'INVOICE:%' $$;
create function rls_test.today() returns date language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;
create function rls_test.fy() returns text language sql stable as $$ select private.financial_year(rls_test.today(), 4) $$;

-- Runs pick -> pack -> ready (and optionally dispatch) for a new pick list; returns the fulfilment id.
create function rls_test.ship(p_so uuid, p_wh uuid, p_lines jsonb, p_dispatch boolean default true) returns uuid language plpgsql as $$
declare r jsonb; f uuid;
begin
  r := public.fulfilment_create(p_so, p_wh, p_lines, null, null, gen_random_uuid());
  f := (r ->> 'fulfilment_id')::uuid;
  perform public.fulfilment_pick(f, (select jsonb_agg(jsonb_build_object('line_id', id, 'quantity_picked', quantity_to_pick)) from public.fulfilment_line_list where fulfilment_id = f), true);
  perform public.fulfilment_pack(f, (select jsonb_agg(jsonb_build_object('line_id', id, 'quantity_packed', quantity_picked)) from public.fulfilment_line_list where fulfilment_id = f), null, true);
  perform public.fulfilment_action(f, 'READY');
  if p_dispatch then perform public.fulfilment_dispatch(f, '{}'::jsonb, gen_random_uuid()); end if;
  return f;
end $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e57500-0000-4000-8000-0000000000a1'), ('company_b', 'e7e57500-0000-4000-8000-0000000000b1'),
  ('acc', 'e7e57500-0000-4000-8000-000000000002'), ('acc2', 'e7e57500-0000-4000-8000-000000000003'), ('sales', 'e7e57500-0000-4000-8000-000000000004'),
  ('im', 'e7e57500-0000-4000-8000-000000000005'), ('viewer', 'e7e57500-0000-4000-8000-000000000006'), ('adm', 'e7e57500-0000-4000-8000-000000000007'),
  ('b_acc', 'e7e57500-0000-4000-8000-000000000008'),
  ('pa', 'e7e57500-0000-4000-8000-0000000000c1'), ('pb', 'e7e57500-0000-4000-8000-0000000000c2'), ('pc', 'e7e57500-0000-4000-8000-0000000000c3'),
  ('w1', 'e7e57500-0000-4000-8000-0000000000e1'), ('quar', 'e7e57500-0000-4000-8000-0000000000f1'),
  ('cu_mh', 'e7e57500-0000-4000-8000-0000000000d1'), ('cu_ka', 'e7e57500-0000-4000-8000-0000000000d2'), ('cu_np', 'e7e57500-0000-4000-8000-0000000000d3'),
  ('cu_b', 'e7e57500-0000-4000-8000-0000000000d4');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code, legal_address, state, gstin) values
  (rls_test.id('company_a'), 'Billing Test A Pvt Ltd', 'Billing A', 'BLA', 'Plot 1, MIDC, Pune 411001', 'Maharashtra', '27ABCDE1234F1Z5'),
  (rls_test.id('company_b'), 'Billing Test B', 'Billing B', 'BLB', null, null, null);
insert into auth.users (id, email) select id, key || '@bl.example.invalid' from rls_test.ids where key in ('acc', 'acc2', 'sales', 'im', 'viewer', 'adm', 'b_acc');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true
  where id in (rls_test.id('acc'), rls_test.id('acc2'), rls_test.id('sales'), rls_test.id('im'), rls_test.id('viewer'), rls_test.id('adm'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_acc');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('acc'),    rls_test.id('company_a'), rls_test.id('role_accounts_manager')),
  (rls_test.id('acc2'),   rls_test.id('company_a'), rls_test.id('role_accounts_manager')),
  (rls_test.id('sales'),  rls_test.id('company_a'), rls_test.id('role_sales_manager')),
  (rls_test.id('im'),     rls_test.id('company_a'), rls_test.id('role_inventory_manager')),
  (rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_management_viewer')),
  (rls_test.id('adm'),    rls_test.id('company_a'), rls_test.id('role_admin')),
  (rls_test.id('b_acc'),  rls_test.id('company_b'), rls_test.id('role_accounts_manager'));

insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, track_batches, track_expiry, hsn_code, gst_rate, selling_price, status) values
  (rls_test.id('pa'), rls_test.id('company_a'), 'BL-BASIN', 'Wash basin', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, '6910', 18, 1000, 'ACTIVE'),
  (rls_test.id('pb'), rls_test.id('company_a'), 'BL-NOHSN', 'Untaxed item', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, null, null, null, 'ACTIVE'),
  (rls_test.id('pc'), rls_test.id('company_a'), 'BL-SEAL', 'Sealant', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', false, false, '3214', 12, 333.33, 'ACTIVE');
insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Main', true);
insert into public.inventory_locations (id, company_id, warehouse_id, location_code, location_name, location_type, stock_usage) values
  (rls_test.id('quar'), rls_test.id('company_a'), rls_test.id('w1'), 'QUAR', 'Quarantine', 'AREA', 'QUARANTINE');
insert into rls_test.ids (key, id) select 'g1', id from public.inventory_locations where location_code = 'GENERAL' and warehouse_id = rls_test.id('w1');

insert into public.customers (id, company_id, customer_code, customer_name, legal_name, gstin, gst_registration_type, billing_address, billing_state_code, payment_terms_days) values
  (rls_test.id('cu_mh'), rls_test.id('company_a'), 'MH1', 'Mumbai Traders', 'Mumbai Traders LLP', '27PQRST5678K1Z2', 'REGISTERED', 'Andheri, Mumbai', '27', 30),
  (rls_test.id('cu_np'), rls_test.id('company_a'), 'NP1', 'Walk-in buyer', null, null, 'UNREGISTERED', null, null, null),
  (rls_test.id('cu_b'), rls_test.id('company_b'), 'B1', 'B buyer', null, null, null, null, null, null);
insert into public.customers (id, company_id, customer_code, customer_name, legal_name, gstin, gst_registration_type, billing_address, billing_state_code,
  shipping_address, shipping_state_code, payment_terms_days) values
  (rls_test.id('cu_ka'), rls_test.id('company_a'), 'KA1', 'Bengaluru Builders', null, '29LMNOP4321Q1Z9', 'REGISTERED', 'Whitefield, Bengaluru', '29', 'Site, Hinjewadi, Pune', '27', 15);

select rls_test.ok('RLS enabled on every public table (including Phase 8 tables)',
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity));
select rls_test.ok('clients cannot write invoice, payment, note, settings or history tables directly',
  not exists (select 1 from unnest(array['sales_invoices', 'sales_invoice_lines', 'sales_invoice_dispatch_allocations', 'customer_payments', 'invoice_payment_allocations',
    'invoice_adjustment_notes', 'invoice_adjustment_note_lines', 'invoice_settings', 'billing_events', 'billing_number_sequences']) t
    where has_table_privilege('authenticated', 'public.' || t, 'INSERT,UPDATE,DELETE')));
select rls_test.ok('no duplicate customer, product, order or dispatch tables were created',
  not exists (select 1 from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'
    and table_name in ('billing_customers', 'invoice_customers', 'invoice_products', 'billing_dispatches', 'invoice_orders')));

-- Stock and sales orders (Phases 4 and 7)
set local role authenticated;
select rls_test.claims('im');
select public.inventory_post_receipt(rls_test.id('pa'), rls_test.id('g1'), 100, 'IN_HOUSE', p_unit_cost => 500, p_idempotency_key => gen_random_uuid());
select public.inventory_post_receipt(rls_test.id('pb'), rls_test.id('g1'), 10, 'IN_HOUSE', p_idempotency_key => gen_random_uuid());
select public.inventory_post_receipt(rls_test.id('pc'), rls_test.id('g1'), 50, 'IN_HOUSE', p_idempotency_key => gen_random_uuid());
select rls_test.claims('sales');
select rls_test.set('so1', public.sales_order_create_manual(jsonb_build_object('customer_id', rls_test.id('cu_mh'), 'warehouse_id', rls_test.id('w1')),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('pa'), 'quantity', 10, 'unit_price', 1000), jsonb_build_object('product_id', rls_test.id('pc'), 'quantity', 3, 'unit_price', 333.33)),
  true, gen_random_uuid()));
select rls_test.set('so2', public.sales_order_create_manual(jsonb_build_object('customer_id', rls_test.id('cu_ka'), 'warehouse_id', rls_test.id('w1')),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('pc'), 'quantity', 3, 'unit_price', 333.33)), true, gen_random_uuid()));
select rls_test.set('so3', public.sales_order_create_manual(jsonb_build_object('customer_id', rls_test.id('cu_np'), 'warehouse_id', rls_test.id('w1')),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('pb'), 'quantity', 2)), true, gen_random_uuid()));
select public.sales_order_allocate(rls_test.gid('so1', 'sales_order_id'), 'IN_HOUSE_FIRST', null, true, gen_random_uuid());
select public.sales_order_allocate(rls_test.gid('so2', 'sales_order_id'), 'IN_HOUSE_FIRST', null, true, gen_random_uuid());
select public.sales_order_allocate(rls_test.gid('so3', 'sales_order_id'), 'IN_HOUSE_FIRST', null, true, gen_random_uuid());
select rls_test.claims('im');
-- F1: 6 basins dispatched. F2: 4 basins + 3 sealant packed but NOT dispatched yet.
select rls_test.set('f1', to_jsonb(rls_test.ship(rls_test.gid('so1', 'sales_order_id'), rls_test.id('w1'),
  jsonb_build_array(jsonb_build_object('reservation_id', rls_test.res_of(rls_test.sol(rls_test.gid('so1', 'sales_order_id'), rls_test.id('pa'))), 'quantity', 6)))));
select rls_test.set('f2', to_jsonb(rls_test.ship(rls_test.gid('so1', 'sales_order_id'), rls_test.id('w1'), null, false)));
select rls_test.set('f3', to_jsonb(rls_test.ship(rls_test.gid('so2', 'sales_order_id'), rls_test.id('w1'), null)));
select rls_test.set('f4', to_jsonb(rls_test.ship(rls_test.gid('so3', 'sales_order_id'), rls_test.id('w1'), null)));
reset role;
insert into rls_test.ids values
  ('f1', (rls_test.get('f1') #>> '{}')::uuid), ('f2', (rls_test.get('f2') #>> '{}')::uuid), ('f3', (rls_test.get('f3') #>> '{}')::uuid), ('f4', (rls_test.get('f4') #>> '{}')::uuid);
insert into rls_test.ids values
  ('fl1', rls_test.fl(rls_test.id('f1'), rls_test.id('pa'))), ('fl2a', rls_test.fl(rls_test.id('f2'), rls_test.id('pa'))), ('fl2c', rls_test.fl(rls_test.id('f2'), rls_test.id('pc'))),
  ('fl3', rls_test.fl(rls_test.id('f3'), rls_test.id('pc'))), ('fl4', rls_test.fl(rls_test.id('f4'), rls_test.id('pb')));
select rls_test.set('tx_before', to_jsonb(rls_test.tx_count(rls_test.id('company_a'))));
select rls_test.set('pa_before', to_jsonb(rls_test.on_hand(rls_test.id('pa'))));
set local role authenticated;
select rls_test.ok('setup: F1 (6 basins), F3, F4 dispatched; F2 packed and ready but not dispatched',
  (select fulfilment_status from public.fulfilments where id = rls_test.id('f2')) = 'READY_FOR_DISPATCH'
  and (select fulfilment_status from public.fulfilments where id = rls_test.id('f1')) = 'DISPATCHED');

-- Settings (Admin)
select rls_test.claims('acc');
select rls_test.expect_call_error('settings: Accounts Manager cannot change billing settings', $q$ select public.billing_settings_update('{"round_off_enabled": true}'::jsonb) $q$, 'billing_settings.manage');
select rls_test.claims('adm');
select rls_test.expect_call_error('settings: numbering longer than 16 characters is refused', $q$ select public.billing_settings_update('{"invoice_prefix": "ALTONHIT", "number_padding": 8}'::jsonb) $q$, '16 characters');
select rls_test.expect_call_ok('settings: Admin enables freight as a configured charge (SAC 996511 @ 18%)', 'settings',
  $q$ select public.billing_settings_update('{"other_charge_enabled": true, "other_charge_label": "Freight", "other_charge_sac": "996511", "other_charge_gst_rate": 18}'::jsonb) $q$);
select rls_test.ok('settings: example number uses the April-March financial year', rls_test.get('settings') ->> 'example_invoice_number' = 'INV/' || substr(rls_test.fy(), 3, 2) || '-' || right(rls_test.fy(), 2) || '/0001'
  and rls_test.get('settings') ->> 'current_financial_year' = rls_test.fy(), rls_test.get('settings')::text);
select rls_test.ok('financial year: 31 Mar belongs to the previous year, 1 Apr to the new one',
  private.financial_year('2027-03-31', 4) = '2026-27' and private.financial_year('2027-04-01', 4) = '2027-28' and private.financial_year('2027-06-15', 1) = '2027');

-- ===========================================================================
-- DRAFTS FROM ACTUAL DISPATCHES ONLY
-- ===========================================================================
select rls_test.claims('viewer');
select rls_test.expect_call_error('drafts: Management Viewer cannot create invoices',
  format($q$ select public.sales_invoice_create_draft(%L::jsonb, '{}'::jsonb, gen_random_uuid()) $q$, jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.id('fl1')))), 'invoices.create');
select rls_test.claims('sales');
select rls_test.expect_call_error('drafts: packed / ready but undispatched goods cannot be invoiced',
  format($q$ select public.sales_invoice_create_draft(%L::jsonb, '{}'::jsonb, gen_random_uuid()) $q$, jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.id('fl2a')))), 'Only dispatched');
select rls_test.expect_call_error('drafts: more than the dispatched quantity is refused',
  format($q$ select public.sales_invoice_create_draft(%L::jsonb, '{}'::jsonb, gen_random_uuid()) $q$, jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.id('fl1'), 'quantity', 7))), 'between 0 and 6');
select rls_test.expect_call_error('drafts: partial invoicing of a dispatch follows company policy (off by default)',
  format($q$ select public.sales_invoice_create_draft(%L::jsonb, '{}'::jsonb, gen_random_uuid()) $q$, jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.id('fl1'), 'quantity', 5))), 'whole dispatched');
select rls_test.expect_call_error('drafts: lines of different customers cannot share an invoice',
  format($q$ select public.sales_invoice_create_draft(%L::jsonb, '{}'::jsonb, gen_random_uuid()) $q$,
    jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.id('fl1')), jsonb_build_object('fulfilment_line_id', rls_test.id('fl3')))), 'same customer');
select rls_test.set('draft_key', to_jsonb(gen_random_uuid()));
select rls_test.expect_call_ok('drafts: Sales Manager drafts an invoice for the 6 dispatched basins', 'inv1',
  format($q$ select public.sales_invoice_create_draft(%L::jsonb, '{"notes": "Thank you"}'::jsonb, %L) $q$, jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.id('fl1'))),
    rls_test.get('draft_key') #>> '{}'));
select rls_test.expect_call_ok('drafts: a retried request returns the same draft', 'inv1_retry',
  format($q$ select public.sales_invoice_create_draft(%L::jsonb, '{}'::jsonb, %L) $q$, jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.id('fl1'))), rls_test.get('draft_key') #>> '{}'));
select rls_test.ok('drafts: retry returned the same invoice (no duplicate)', rls_test.gid('inv1_retry', 'invoice_id') = rls_test.gid('inv1', 'invoice_id')
  and (select count(*) from public.sales_invoices where company_id = rls_test.id('company_a')) = 1);
select rls_test.expect_call_error('drafts: the same dispatched quantity cannot be put on a second invoice (concurrent / duplicate)',
  format($q$ select public.sales_invoice_create_draft(%L::jsonb, '{}'::jsonb, gen_random_uuid()) $q$, jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.id('fl1')))), 'nothing is left');
select rls_test.ok('drafts: a draft has no official number and creates no receivable',
  (rls_test.inv(rls_test.gid('inv1', 'invoice_id'))).invoice_number is null and (rls_test.inv(rls_test.gid('inv1', 'invoice_id'))).status = 'DRAFT'
  and (select count(*) from public.billing_receivables(rls_test.today())) = 0);
select rls_test.ok('GST: intra-state (27 -> 27) 6 x 1000 = 6000 taxable, CGST 540 + SGST 540 = 7080',
  (select tax_treatment = 'INTRA_STATE' and taxable_subtotal = 6000 and cgst_total = 540 and sgst_total = 540 and igst_total = 0 and grand_total = 7080
   and place_of_supply_state_code = '27' from public.sales_invoices where id = rls_test.gid('inv1', 'invoice_id')));
select rls_test.ok('drafts: line traces the sales order, its line and the dispatch line; product master price/HSN/rate used',
  (select sales_order_id = rls_test.gid('so1', 'sales_order_id') and fulfilment_line_id = rls_test.id('fl1') and hsn_sac = '6910' and gst_rate = 18 and unit_price = 1000
   from public.sales_invoice_lines where invoice_id = rls_test.gid('inv1', 'invoice_id')));
select rls_test.expect_call_error('drafts: discounts need the company setting', format($q$ select public.sales_invoice_update_draft(%L, null, %L::jsonb) $q$, rls_test.gid('inv1', 'invoice_id'),
  jsonb_build_array(jsonb_build_object('line_id', rls_test.iline(rls_test.gid('inv1', 'invoice_id'), rls_test.id('pa')), 'discount_percent', 5))), 'discount');

-- ===========================================================================
-- ISSUE, NUMBERING, IMMUTABILITY
-- ===========================================================================
select rls_test.expect_call_error('issue: Sales Manager cannot issue invoices', format($q$ select public.sales_invoice_issue(%L, gen_random_uuid()) $q$, rls_test.gid('inv1', 'invoice_id')), 'invoices.issue');
select rls_test.claims('im');
select rls_test.expect_call_error('issue: Inventory Manager cannot issue invoices', format($q$ select public.sales_invoice_issue(%L, gen_random_uuid()) $q$, rls_test.gid('inv1', 'invoice_id')), 'invoices.issue');
select rls_test.claims('acc');
select rls_test.set('issue_key', to_jsonb(gen_random_uuid()));
select rls_test.expect_call_ok('issue: Accounts Manager issues the invoice', 'inv1_issued',
  format($q$ select public.sales_invoice_issue(%L, %L) $q$, rls_test.gid('inv1', 'invoice_id'), rls_test.get('issue_key') #>> '{}'));
select rls_test.ok('issue: official number INV/<fy>/0001 assigned at issue with financial year and due date',
  rls_test.get('inv1_issued') ->> 'invoice_number' = 'INV/' || substr(rls_test.fy(), 3, 2) || '-' || right(rls_test.fy(), 2) || '/0001'
  and (rls_test.inv(rls_test.gid('inv1', 'invoice_id'))).financial_year = rls_test.fy()
  and (rls_test.inv(rls_test.gid('inv1', 'invoice_id'))).due_date = rls_test.today() + 30
  and (rls_test.inv(rls_test.gid('inv1', 'invoice_id'))).issued_by = rls_test.id('acc'), rls_test.get('inv1_issued')::text);
select rls_test.expect_call_ok('issue: a retried issue (same key) returns the same number', 'inv1_issued2',
  format($q$ select public.sales_invoice_issue(%L, %L) $q$, rls_test.gid('inv1', 'invoice_id'), rls_test.get('issue_key') #>> '{}'));
select rls_test.ok('issue: retry did not consume another number', rls_test.get('inv1_issued2') ->> 'invoice_number' = rls_test.get('inv1_issued') ->> 'invoice_number'
  and rls_test.inv_seq() = 1);
select rls_test.expect_call_error('issue: issuing again with a new request is refused', format($q$ select public.sales_invoice_issue(%L, gen_random_uuid()) $q$, rls_test.gid('inv1', 'invoice_id')), 'already');
select rls_test.ok('issue: issuing an invoice changed no stock', rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx_before') #>> '{}')::int);
select rls_test.ok('receivables: the issued invoice is now receivable (7080, not yet due)',
  (select count(*) = 1 and min((r ->> 'balance')::numeric) = 7080 and min(r ->> 'bucket') = 'NOT_DUE' from public.billing_receivables(rls_test.today()) r));
select rls_test.expect_call_error('immutability: an issued invoice cannot be edited through the draft RPC',
  format($q$ select public.sales_invoice_update_draft(%L, '{"notes": "x"}'::jsonb) $q$, rls_test.gid('inv1', 'invoice_id')), 'Only draft');
reset role;
select rls_test.expect_error('immutability: even the owner cannot change an issued invoice''s totals',
  format($q$ update public.sales_invoices set grand_total = 1, taxable_subtotal = 1, cgst_total = 0, sgst_total = 0 where id = %L $q$, rls_test.gid('inv1', 'invoice_id')));
select rls_test.expect_error('immutability: issued invoice lines cannot be changed',
  format($q$ update public.sales_invoice_lines set unit_price = 1 where invoice_id = %L $q$, rls_test.gid('inv1', 'invoice_id')));
select rls_test.expect_error('immutability: invoices are never deleted', format($q$ delete from public.sales_invoices where id = %L $q$, rls_test.gid('inv1', 'invoice_id')));
-- Master data changes after issue must not change the issued document (print uses snapshots).
update public.customers set billing_address = 'New office, Thane' where id = rls_test.id('cu_mh');
update public.products set hsn_code = '691010', gst_rate = 28 where id = rls_test.id('pa');
select rls_test.ok('snapshots: customer address and product HSN/rate changes do not alter the issued invoice',
  (rls_test.inv(rls_test.gid('inv1', 'invoice_id'))).customer_billing_address = 'Andheri, Mumbai'
  and (select hsn_sac = '6910' and gst_rate = 18 and line_total = 7080 from public.sales_invoice_lines where invoice_id = rls_test.gid('inv1', 'invoice_id')));
update public.products set hsn_code = '6910', gst_rate = 18 where id = rls_test.id('pa');
set local role authenticated;

-- ===========================================================================
-- PARTIAL DISPATCHES, ROUNDING, CHARGES, ROUND-OFF
-- ===========================================================================
select rls_test.claims('im');
select public.fulfilment_dispatch(rls_test.id('f2'), '{}'::jsonb, gen_random_uuid());
select rls_test.claims('sales');
select rls_test.expect_call_ok('partial dispatch: the second consignment of the same order is invoiced separately', 'inv2',
  format($q$ select public.sales_invoice_create_draft(%L::jsonb, '{}'::jsonb, gen_random_uuid()) $q$,
    jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.id('fl2a')), jsonb_build_object('fulfilment_line_id', rls_test.id('fl2c')))));
select rls_test.ok('rounding: 4 x 1000 @18% + 3 x 333.33 @12% -> taxable 4999.99, CGST 420.00, SGST 420.00, total 5839.99 (line-level half-up)',
  (select taxable_subtotal = 4999.99 and cgst_total = 420 and sgst_total = 420 and grand_total = 5839.99 from public.sales_invoices where id = rls_test.gid('inv2', 'invoice_id')),
  (select row_to_json(i)::text from public.sales_invoices i where id = rls_test.gid('inv2', 'invoice_id')));
select rls_test.expect_call_ok('charges: configured freight 500 added (taxed at its configured rate)', 'inv2_charge',
  format($q$ select public.sales_invoice_update_draft(%L, null, null, '{"amount": 500}'::jsonb) $q$, rls_test.gid('inv2', 'invoice_id')));
select rls_test.ok('charges: totals 5499.99 taxable + 465 CGST + 465 SGST = 6429.99; sum of lines reconciles to the header',
  (select taxable_subtotal = 5499.99 and other_charges_total = 500 and cgst_total = 465 and sgst_total = 465 and grand_total = 6429.99
     and grand_total = (select sum(line_total) from public.sales_invoice_lines where invoice_id = i.id) + round_off
   from public.sales_invoices i where id = rls_test.gid('inv2', 'invoice_id')));
select rls_test.claims('adm');
select public.billing_settings_update('{"round_off_enabled": true}'::jsonb);
select rls_test.claims('sales');
select public.sales_invoice_action(rls_test.gid('inv2', 'invoice_id'), 'REFRESH');
select rls_test.ok('round-off: enabled -> grand total 6430.00 with round-off +0.01',
  (select grand_total = 6430 and round_off = 0.01 from public.sales_invoices where id = rls_test.gid('inv2', 'invoice_id')));
select rls_test.claims('acc');
select rls_test.expect_call_ok('numbering: second invoice issued', 'inv2_issued', format($q$ select public.sales_invoice_issue(%L, gen_random_uuid()) $q$, rls_test.gid('inv2', 'invoice_id')));
select rls_test.ok('numbering: sequential and unique (0002)', rls_test.get('inv2_issued') ->> 'invoice_number' like '%/0002'
  and (select count(distinct invoice_number) = 2 from public.sales_invoices where company_id = rls_test.id('company_a') and invoice_number is not null));

-- ===========================================================================
-- INTER-STATE, REVIEW ITEMS, MISSING TAX DATA
-- ===========================================================================
select rls_test.claims('sales');
select rls_test.expect_call_ok('inter-state: draft for the Karnataka customer', 'inv3',
  format($q$ select public.sales_invoice_create_draft(%L::jsonb, '{}'::jsonb, gen_random_uuid()) $q$, jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.id('fl3')))));
select rls_test.ok('inter-state: place of supply 29 (GSTIN state) -> IGST 12% on 999.99 = 120.00, no CGST/SGST, round-off applied',
  (select tax_treatment = 'INTER_STATE' and place_of_supply_state_code = '29' and igst_total = 120 and cgst_total = 0 and taxable_subtotal = 999.99 and grand_total = 1120 and round_off = 0.01
   from public.sales_invoices where id = rls_test.gid('inv3', 'invoice_id')));
select rls_test.ok('review: shipping state (27) differs from place of supply (29) -> flagged for review, not silently decided',
  exists (select 1 from jsonb_array_elements(public.sales_invoice_validate(rls_test.gid('inv3', 'invoice_id'))) i where i ->> 'code' = 'SHIP_STATE' and i ->> 'severity' = 'REVIEW'));
select rls_test.claims('acc');
select rls_test.expect_call_error('review: issue is blocked until an authorised reviewer acknowledges', format($q$ select public.sales_invoice_issue(%L, gen_random_uuid()) $q$, rls_test.gid('inv3', 'invoice_id')), 'review');
select rls_test.expect_call_ok('review: Accounts Manager records the review conclusion', 'inv3_ack',
  format($q$ select public.sales_invoice_action(%L, 'ACK_TAX_REVIEW', 'Bill-to Karnataka registered buyer; POS 29 per Section 10(1)(b) confirmed') $q$, rls_test.gid('inv3', 'invoice_id')));
select rls_test.expect_call_ok('review: issued after acknowledgement', 'inv3_issued', format($q$ select public.sales_invoice_issue(%L, gen_random_uuid()) $q$, rls_test.gid('inv3', 'invoice_id')));

select rls_test.claims('sales');
select rls_test.expect_call_ok('missing data: a draft can be created for incomplete master data', 'inv4',
  format($q$ select public.sales_invoice_create_draft(%L::jsonb, '{}'::jsonb, gen_random_uuid()) $q$, jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.id('fl4')))));
select rls_test.ok('missing data: validation lists billing address, place of supply, HSN, GST rate and price as blocking',
  (select array_agg(i ->> 'code' order by i ->> 'code') @> array['CUSTOMER_ADDRESS', 'GST_RATE', 'HSN', 'PLACE_OF_SUPPLY', 'PRICE', 'TAX_TREATMENT']
   from jsonb_array_elements(public.sales_invoice_validate(rls_test.gid('inv4', 'invoice_id'))) i where i ->> 'severity' = 'BLOCK'));
select rls_test.claims('acc');
select rls_test.expect_call_error('missing data: issue is blocked with an explanation', format($q$ select public.sales_invoice_issue(%L, gen_random_uuid()) $q$, rls_test.gid('inv4', 'invoice_id')),
  'HSN/SAC code is missing');
select rls_test.ok('missing data: the blocked attempt consumed no invoice number', (rls_test.inv(rls_test.gid('inv4', 'invoice_id'))).invoice_number is null
  and rls_test.inv_seq() = 3);
select rls_test.claims('sales');
select rls_test.expect_call_ok('drafts: discard keeps the record (no deletion) and frees the dispatch quantity', 'inv4_disc',
  format($q$ select public.sales_invoice_action(%L, 'DISCARD') $q$, rls_test.gid('inv4', 'invoice_id')));
select rls_test.ok('drafts: discarded draft is kept and its quantity is invoiceable again',
  (rls_test.inv(rls_test.gid('inv4', 'invoice_id'))).status = 'DISCARDED' and private.dispatch_line_invoiceable(rls_test.id('fl4')) = 2);

-- ===========================================================================
-- PAYMENTS AND ALLOCATIONS
-- ===========================================================================
select rls_test.claims('viewer');
select rls_test.expect_call_error('payments: Management Viewer cannot record receipts',
  format($q$ select public.customer_payment_record(%L::jsonb, null, gen_random_uuid()) $q$, jsonb_build_object('customer_id', rls_test.id('cu_mh'), 'amount', 100, 'payment_method', 'UPI')), 'payments.manage');
select rls_test.claims('acc');
select rls_test.set('pay_key', to_jsonb(gen_random_uuid()));
select rls_test.expect_call_ok('payments: 5000 by bank transfer allocated to INV-1 (partial payment)', 'pay1',
  format($q$ select public.customer_payment_record(%L::jsonb, %L::jsonb, %L) $q$,
    jsonb_build_object('customer_id', rls_test.id('cu_mh'), 'amount', 5000, 'payment_method', 'BANK_TRANSFER', 'transaction_reference', 'UTR123'),
    jsonb_build_array(jsonb_build_object('invoice_id', rls_test.gid('inv1', 'invoice_id'), 'amount', 5000)), rls_test.get('pay_key') #>> '{}'));
select rls_test.expect_call_ok('payments: a retried request returns the same receipt', 'pay1_retry',
  format($q$ select public.customer_payment_record(%L::jsonb, %L::jsonb, %L) $q$,
    jsonb_build_object('customer_id', rls_test.id('cu_mh'), 'amount', 5000, 'payment_method', 'BANK_TRANSFER', 'transaction_reference', 'UTR123'),
    jsonb_build_array(jsonb_build_object('invoice_id', rls_test.gid('inv1', 'invoice_id'), 'amount', 5000)), rls_test.get('pay_key') #>> '{}'));
select rls_test.ok('payments: no duplicate receipt or allocation from the retry; balance 7080 - 5000 = 2080, partially paid',
  (select count(*) from public.customer_payments where company_id = rls_test.id('company_a')) = 1
  and (select count(*) from public.invoice_payment_allocations where company_id = rls_test.id('company_a')) = 1
  and rls_test.bal(rls_test.gid('inv1', 'invoice_id')) = 2080
  and (select payment_status from public.sales_invoice_list where id = rls_test.gid('inv1', 'invoice_id')) = 'PARTIALLY_PAID');
select rls_test.expect_call_error('payments: the same bank reference cannot be recorded twice for the customer',
  format($q$ select public.customer_payment_record(%L::jsonb, null, gen_random_uuid()) $q$,
    jsonb_build_object('customer_id', rls_test.id('cu_mh'), 'amount', 10, 'payment_method', 'BANK_TRANSFER', 'transaction_reference', 'utr123')), 'already recorded');
select rls_test.expect_call_ok('payments: receipt of 10000 with no allocation stays unallocated (on account)', 'pay2',
  format($q$ select public.customer_payment_record(%L::jsonb, null, gen_random_uuid()) $q$,
    jsonb_build_object('customer_id', rls_test.id('cu_mh'), 'amount', 10000, 'payment_method', 'CHEQUE', 'transaction_reference', 'CHQ-9')));
select rls_test.expect_call_error('allocation: cannot exceed the invoice balance (over-allocation)',
  format($q$ select public.customer_payment_allocate(%L, %L::jsonb, gen_random_uuid()) $q$, rls_test.gid('pay2', 'payment_id'),
    jsonb_build_array(jsonb_build_object('invoice_id', rls_test.gid('inv1', 'invoice_id'), 'amount', 2080.01))), 'balance');
select rls_test.expect_call_error('allocation: cannot use another customer''s invoice (cross-customer)',
  format($q$ select public.customer_payment_allocate(%L, %L::jsonb, gen_random_uuid()) $q$, rls_test.gid('pay2', 'payment_id'),
    jsonb_build_array(jsonb_build_object('invoice_id', rls_test.gid('inv3', 'invoice_id'), 'amount', 100))), 'another customer');
select rls_test.expect_call_ok('allocation: one receipt split across two invoices (2080 + 6430)', 'pay2_alloc',
  format($q$ select public.customer_payment_allocate(%L, %L::jsonb, gen_random_uuid()) $q$, rls_test.gid('pay2', 'payment_id'),
    jsonb_build_array(jsonb_build_object('invoice_id', rls_test.gid('inv1', 'invoice_id'), 'amount', 2080), jsonb_build_object('invoice_id', rls_test.gid('inv2', 'invoice_id'), 'amount', 6430))));
select rls_test.ok('allocation: both invoices paid; 1490 of the receipt remains unallocated',
  (select payment_status from public.sales_invoice_list where id = rls_test.gid('inv1', 'invoice_id')) = 'PAID'
  and rls_test.bal(rls_test.gid('inv2', 'invoice_id')) = 0 and (rls_test.get('pay2_alloc') ->> 'unallocated')::numeric = 1490
  and (select unallocated_amount from public.customer_payment_list where id = rls_test.gid('pay2', 'payment_id')) = 1490);
select rls_test.expect_call_error('allocation: cannot exceed the unallocated receipt amount', format($q$ select public.customer_payment_allocate(%L, %L::jsonb, gen_random_uuid()) $q$,
  rls_test.gid('pay2', 'payment_id'), jsonb_build_array(jsonb_build_object('invoice_id', rls_test.gid('inv1', 'invoice_id'), 'amount', 1))), 'balance');
reset role;
select rls_test.expect_error('payments: recorded receipts cannot be edited directly (even by the owner)',
  format($q$ update public.customer_payments set amount_received = 1 where id = %L $q$, rls_test.gid('pay1', 'payment_id')));
select rls_test.expect_error('payments: allocations are never deleted', format($q$ delete from public.invoice_payment_allocations where payment_id = %L $q$, rls_test.gid('pay1', 'payment_id')));
set local role authenticated;
select rls_test.claims('sales');
select rls_test.expect_call_error('payments: Sales Manager cannot reverse payments', format($q$ select public.customer_payment_reverse(%L, 'test test', gen_random_uuid()) $q$, rls_test.gid('pay1', 'payment_id')), 'payments.reverse');

-- ===========================================================================
-- CREDIT AND DEBIT NOTES
-- ===========================================================================
-- Two basins come back from F1 (Phase 7 return into quarantine).
select rls_test.claims('sales');
select rls_test.set('ret', public.customer_return_create(rls_test.gid('so1', 'sales_order_id'), '{"reason_code": "DEFECTIVE"}'::jsonb,
  jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.id('fl1'), 'quantity', 2)), gen_random_uuid()));
select public.customer_return_review(rls_test.gid('ret', 'return_id'), 'AUTHORIZE');
select rls_test.claims('im');
select public.customer_return_receive(rls_test.gid('ret', 'return_id'), rls_test.id('quar'), null, null, null, gen_random_uuid());
reset role;
insert into rls_test.ids values ('rl', (select id from public.customer_return_lines where return_id = rls_test.gid('ret', 'return_id')));
select rls_test.set('pa_after_return', to_jsonb(rls_test.on_hand(rls_test.id('pa'))));
select rls_test.set('tx_after_return', to_jsonb(rls_test.tx_count(rls_test.id('company_a'))));
set local role authenticated;
select rls_test.ok('returns: received goods do not make an invoiced dispatch invoiceable again', private.dispatch_line_invoiceable(rls_test.id('fl1')) = 0);
select rls_test.claims('acc');
select rls_test.expect_call_ok('credit note: 2 returned basins credited against INV-1, linked to the return line', 'cn1',
  format($q$ select public.adjustment_note_create(%L, 'CREDIT', %L::jsonb, %L::jsonb, gen_random_uuid()) $q$, rls_test.gid('inv1', 'invoice_id'),
    jsonb_build_object('reason_code', 'SALES_RETURN', 'reason', 'Defective basins returned', 'customer_return_id', rls_test.gid('ret', 'return_id')),
    jsonb_build_array(jsonb_build_object('invoice_line_id', rls_test.iline(rls_test.gid('inv1', 'invoice_id'), rls_test.id('pa')), 'quantity', 2, 'customer_return_line_id', rls_test.id('rl')))));
select rls_test.expect_call_error('credit note: the same returned quantity cannot be credited twice',
  format($q$ select public.adjustment_note_create(%L, 'CREDIT', '{"reason_code": "SALES_RETURN", "reason": "again"}'::jsonb, %L::jsonb, gen_random_uuid()) $q$, rls_test.gid('inv1', 'invoice_id'),
    jsonb_build_array(jsonb_build_object('invoice_line_id', rls_test.iline(rls_test.gid('inv1', 'invoice_id'), rls_test.id('pa')), 'quantity', 1, 'customer_return_line_id', rls_test.id('rl')))), 'not yet credited');
select rls_test.expect_call_error('credit note: cannot credit more units than invoiced and not yet credited (6 - 2 = 4)',
  format($q$ select public.adjustment_note_create(%L, 'CREDIT', '{"reason_code": "QUALITY_ISSUE", "reason": "too many"}'::jsonb, %L::jsonb, gen_random_uuid()) $q$, rls_test.gid('inv1', 'invoice_id'),
    jsonb_build_array(jsonb_build_object('invoice_line_id', rls_test.iline(rls_test.gid('inv1', 'invoice_id'), rls_test.id('pa')), 'quantity', 5))), 'at most 4 units');
select rls_test.ok('credit note: draft computed at the invoice''s treatment: 2000 + CGST 180 + SGST 180 = 2360; draft does not change the balance',
  (select taxable_amount = 2000 and cgst_amount = 180 and sgst_amount = 180 and total_amount = 2360 and note_number is null from public.invoice_adjustment_notes where id = rls_test.gid('cn1', 'note_id'))
  and rls_test.bal(rls_test.gid('inv1', 'invoice_id')) = 0);
select rls_test.expect_call_ok('credit note: issued', 'cn1_issued', format($q$ select public.adjustment_note_issue(%L, gen_random_uuid()) $q$, rls_test.gid('cn1', 'note_id')));
select rls_test.ok('credit note: number CN/<fy>/0001; invoice now has a 2360 credit balance (already fully paid); no stock or ledger change',
  rls_test.get('cn1_issued') ->> 'note_number' like 'CN/%/0001' and rls_test.bal(rls_test.gid('inv1', 'invoice_id')) = -2360
  and rls_test.on_hand(rls_test.id('pa')) = (rls_test.get('pa_after_return') #>> '{}')::numeric
  and rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx_after_return') #>> '{}')::int);
select rls_test.expect_call_ok('debit note: additional charge of 1000 on INV-3 (draft)', 'dn1',
  format($q$ select public.adjustment_note_create(%L, 'DEBIT', '{"reason_code": "ADDITIONAL_CHARGE", "reason": "Unloading charges agreed"}'::jsonb, %L::jsonb, gen_random_uuid()) $q$,
    rls_test.gid('inv3', 'invoice_id'), jsonb_build_array(jsonb_build_object('invoice_line_id', rls_test.iline(rls_test.gid('inv3', 'invoice_id'), rls_test.id('pc')), 'taxable_amount', 1000))));
select rls_test.expect_call_error('debit note: tax treatment of an additional charge needs review before issue', format($q$ select public.adjustment_note_issue(%L, gen_random_uuid()) $q$, rls_test.gid('dn1', 'note_id')), 'review');
select rls_test.expect_call_ok('debit note: tax review acknowledged by an authorised user', 'dn1_ack',
  format($q$ select public.adjustment_note_action(%L, 'ACK_TAX_REVIEW', 'Reviewed: taxable as part of the supply at 12%% IGST') $q$, rls_test.gid('dn1', 'note_id')));
select rls_test.expect_call_ok('debit note: issued after review', 'dn1_issued', format($q$ select public.adjustment_note_issue(%L, gen_random_uuid()) $q$, rls_test.gid('dn1', 'note_id')));
select rls_test.ok('debit note: IGST at the invoice''s inter-state treatment; INV-3 balance 1120 + 1120 = 2240',
  (select igst_amount = 120 and cgst_amount = 0 and total_amount = 1120 from public.invoice_adjustment_notes where id = rls_test.gid('dn1', 'note_id'))
  and rls_test.bal(rls_test.gid('inv3', 'invoice_id')) = 2240);
reset role;
select rls_test.expect_error('notes: issued notes are immutable', format($q$ update public.invoice_adjustment_notes set total_amount = 1, taxable_amount = 1, igst_amount = 0 where id = %L $q$, rls_test.gid('dn1', 'note_id')));
set local role authenticated;

-- ===========================================================================
-- CANCELLATION
-- ===========================================================================
select rls_test.claims('acc');
select rls_test.expect_call_error('cancel: an invoice with payment allocations cannot be cancelled silently',
  format($q$ select public.sales_invoice_action(%L, 'CANCEL', 'Customer disputes') $q$, rls_test.gid('inv2', 'invoice_id')), 'payment allocation');
select rls_test.expect_call_error('cancel: an invoice with notes cannot be cancelled', format($q$ select public.sales_invoice_action(%L, 'CANCEL', 'Customer disputes') $q$, rls_test.gid('inv3', 'invoice_id')), 'notes');
select rls_test.expect_call_ok('cancel: allocation reversed with a reason (history kept)', 'rev1',
  format($q$ select public.payment_allocation_reverse((select id from public.invoice_payment_allocations where invoice_id = %L and status = 'ACTIVE'), 'Wrong invoice selected') $q$,
    rls_test.gid('inv2', 'invoice_id')));
select rls_test.expect_call_ok('cancel: INV-2 cancelled with a reason', 'inv2_cancel', format($q$ select public.sales_invoice_action(%L, 'CANCEL', 'Raised on wrong billing entity') $q$, rls_test.gid('inv2', 'invoice_id')));
select rls_test.ok('cancel: number kept, no stock movement, and the dispatch quantity can be invoiced again',
  (rls_test.inv(rls_test.gid('inv2', 'invoice_id'))).invoice_number like '%/0002' and (rls_test.inv(rls_test.gid('inv2', 'invoice_id'))).status = 'CANCELLED'
  and rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx_after_return') #>> '{}')::int
  and private.dispatch_line_invoiceable(rls_test.id('fl2a')) = 4);
select rls_test.ok('cancel: the reversed allocation still exists (REVERSED) and its money is back on the receipt',
  (select count(*) from public.invoice_payment_allocations where invoice_id = rls_test.gid('inv2', 'invoice_id') and status = 'REVERSED') = 1
  and (select unallocated_amount from public.customer_payment_list where id = rls_test.gid('pay2', 'payment_id')) = 7920);
select rls_test.claims('sales');
select rls_test.set('inv5', public.sales_invoice_create_draft(jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.id('fl2a')), jsonb_build_object('fulfilment_line_id', rls_test.id('fl2c'))),
  '{}'::jsonb, gen_random_uuid()));
select rls_test.claims('acc');
select rls_test.expect_call_ok('cancel: re-invoiced on a new invoice', 'inv5_issued', format($q$ select public.sales_invoice_issue(%L, gen_random_uuid()) $q$, rls_test.gid('inv5', 'invoice_id')));
select rls_test.ok('numbering: cancelled numbers are never reused (new invoice is 0004)', rls_test.get('inv5_issued') ->> 'invoice_number' like '%/0004');

-- ===========================================================================
-- APPROVAL WORKFLOW AND SEGREGATION OF DUTIES
-- ===========================================================================
select rls_test.claims('adm');
select public.billing_settings_update('{"require_approval": true, "allow_partial_dispatch_invoicing": true}'::jsonb);
select rls_test.claims('acc');
select rls_test.set('inv6', public.sales_invoice_create_draft(jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.id('fl4'), 'quantity', 1)), '{}'::jsonb, gen_random_uuid()));
select rls_test.ok('policy: partial invoicing of a dispatch allowed once enabled (1 of 2)', (select quantity from public.sales_invoice_lines where invoice_id = rls_test.gid('inv6', 'invoice_id')) = 1);
select rls_test.expect_call_error('approval: a draft cannot be issued directly when approval is required', format($q$ select public.sales_invoice_issue(%L, gen_random_uuid()) $q$, rls_test.gid('inv6', 'invoice_id')), 'approval');
select rls_test.expect_call_error('approval: a draft with blocking problems cannot be submitted', format($q$ select public.sales_invoice_action(%L, 'SUBMIT') $q$, rls_test.gid('inv6', 'invoice_id')), 'validation');
reset role;
update public.customers set billing_address = 'Shop 4, Pune', billing_state_code = '27' where id = rls_test.id('cu_np');
update public.products set hsn_code = '3922', gst_rate = 18, selling_price = 250 where id = rls_test.id('pb');
set local role authenticated;
select rls_test.claims('acc');
select public.sales_invoice_action(rls_test.gid('inv6', 'invoice_id'), 'REFRESH');
select public.sales_invoice_update_draft(rls_test.gid('inv6', 'invoice_id'), null, jsonb_build_array(jsonb_build_object('line_id', (select id from public.sales_invoice_lines where invoice_id = rls_test.gid('inv6', 'invoice_id')), 'unit_price', 250)));
select rls_test.expect_call_ok('approval: submitted after master data was completed (B2C, place of supply = billing state 27)', 'inv6_sub',
  format($q$ select public.sales_invoice_action(%L, 'SUBMIT') $q$, rls_test.gid('inv6', 'invoice_id')));
select rls_test.expect_call_error('approval: the submitter cannot approve and issue (segregation of duties)', format($q$ select public.sales_invoice_issue(%L, gen_random_uuid()) $q$, rls_test.gid('inv6', 'invoice_id')), 'Segregation');
select rls_test.claims('acc2');
select rls_test.expect_call_ok('approval: a second Accounts Manager approves and issues', 'inv6_issued', format($q$ select public.sales_invoice_issue(%L, gen_random_uuid()) $q$, rls_test.gid('inv6', 'invoice_id')));
select rls_test.ok('approval: issued totals 250 + 22.50 + 22.50 = 295 (round-off 0)',
  (select grand_total = 295 and round_off = 0 and cgst_total = 22.5 from public.sales_invoices where id = rls_test.gid('inv6', 'invoice_id')));
select rls_test.claims('acc');
select rls_test.set('cn_sod', public.adjustment_note_create(rls_test.gid('inv6', 'invoice_id'), 'CREDIT', '{"reason_code": "PRICE_CORRECTION", "reason": "Agreed price reduction"}'::jsonb,
  jsonb_build_array(jsonb_build_object('invoice_line_id', rls_test.iline(rls_test.gid('inv6', 'invoice_id'), rls_test.id('pb')), 'taxable_amount', 10)), gen_random_uuid()));
select rls_test.expect_call_error('approval: a credit note cannot be issued directly when approval is required', format($q$ select public.adjustment_note_issue(%L, gen_random_uuid()) $q$, rls_test.gid('cn_sod', 'note_id')), 'approval');
select public.adjustment_note_action(rls_test.gid('cn_sod', 'note_id'), 'SUBMIT');
select rls_test.expect_call_error('approval: the credit note submitter cannot approve and issue it (segregation of duties)', format($q$ select public.adjustment_note_issue(%L, gen_random_uuid()) $q$, rls_test.gid('cn_sod', 'note_id')), 'Segregation');
select public.adjustment_note_action(rls_test.gid('cn_sod', 'note_id'), 'DISCARD');
select rls_test.ok('approval: the discarded note never got a number and does not change the balance (295)',
  (select note_number is null and status = 'DISCARDED' from public.invoice_adjustment_notes where id = rls_test.gid('cn_sod', 'note_id')) and rls_test.bal(rls_test.gid('inv6', 'invoice_id')) = 295);

-- ===========================================================================
-- PAYMENT REVERSAL, AGEING, STATEMENTS, REPORTS
-- ===========================================================================
select rls_test.claims('acc');
select rls_test.expect_call_ok('payments: receipt reversed (e.g. cheque dishonoured); its allocations are reversed with it', 'pay2_rev',
  format($q$ select public.customer_payment_reverse(%L, 'Cheque dishonoured', gen_random_uuid()) $q$, rls_test.gid('pay2', 'payment_id')));
select rls_test.ok('payments: INV-1 balance back to 2080 - 2360 = -280 (credit note exceeds what remains); receipt kept as REVERSED',
  rls_test.bal(rls_test.gid('inv1', 'invoice_id')) = -280 and (select status from public.customer_payments where id = rls_test.gid('pay2', 'payment_id')) = 'REVERSED'
  and (select count(*) from public.invoice_payment_allocations where payment_id = rls_test.gid('pay2', 'payment_id') and status = 'REVERSED') = 2);
select rls_test.ok('ageing: as of today every open invoice is "not yet due"',
  (select bool_and(r ->> 'bucket' = 'NOT_DUE') from public.billing_receivables(rls_test.today()) r));
select rls_test.ok('ageing: as of today + 45 days INV-5 (30-day terms) is 15 days overdue in 1-30; INV-3 (15-day terms) 30 days in 1-30',
  (select (r ->> 'days_overdue')::int = 15 and r ->> 'bucket' = '1_30' from public.billing_receivables(rls_test.today() + 45) r where r ->> 'invoice_id' = rls_test.gid('inv5', 'invoice_id')::text)
  and (select (r ->> 'days_overdue')::int = 30 and r ->> 'bucket' = '1_30' from public.billing_receivables(rls_test.today() + 45) r where r ->> 'invoice_id' = rls_test.gid('inv3', 'invoice_id')::text));
select rls_test.ok('ageing: as of today + 120 days INV-3 is over 90 days', (select r ->> 'bucket' from public.billing_receivables(rls_test.today() + 120) r where r ->> 'invoice_id' = rls_test.gid('inv3', 'invoice_id')::text) = 'OVER_90');
select rls_test.ok('ageing: as of yesterday nothing is outstanding (invoices dated today)', (select count(*) from public.billing_receivables(rls_test.today() - 1)) = 0);
select rls_test.set('stmt', public.billing_customer_statement(rls_test.id('cu_mh'), rls_test.today() - 30, rls_test.today()));
select rls_test.ok('statement: closing balance equals the customer''s open invoice balances (INV-1 -280 + INV-5 5840 = 5560)',
  (rls_test.get('stmt') ->> 'closing_balance')::numeric = 5560
  and (rls_test.get('stmt') ->> 'closing_balance')::numeric = (select sum((r ->> 'balance')::numeric) from public.billing_receivables(rls_test.today()) r where (r ->> 'customer_id')::uuid = rls_test.id('cu_mh')),
  rls_test.get('stmt')::text);
select rls_test.ok('reports: all billing reports run',
  (select bool_and(n >= 0) from (select (select count(*) from public.billing_report(k, rls_test.today() - 30, rls_test.today())) n
     from unnest(array['INVOICES', 'BY_GST_RATE', 'TAX_COMPONENTS', 'HSN_SUMMARY', 'CUSTOMER_WISE', 'MONTHLY_INVOICING', 'COLLECTIONS_BY_MONTH', 'OUTSTANDING',
       'OVERDUE', 'NOTES', 'UNALLOCATED_RECEIPTS', 'CANCELLED']) k) x));
select rls_test.ok('reports: tax components net of notes equal invoices - credit notes + debit notes',
  (select (r ->> 'cgst')::numeric = (select sum(cgst_total) from public.sales_invoices where company_id = rls_test.id('company_a') and status = 'ISSUED') - 180
     and (r ->> 'igst')::numeric = (select sum(igst_total) from public.sales_invoices where company_id = rls_test.id('company_a') and status = 'ISSUED') + 120
   from public.billing_report('TAX_COMPONENTS', rls_test.today() - 30, rls_test.today()) r));
select rls_test.expect_rows('reports: cancelled report lists the cancelled invoice and the reversed receipt',
  format($q$ select * from public.billing_report('CANCELLED', %L, %L) $q$, rls_test.today() - 1, rls_test.today()), 2);
select rls_test.set('ov', public.billing_overview(rls_test.today() - 30, rls_test.today()));
select rls_test.ok('overview: invoiced total and counts from issued invoices only (no draft, discarded or cancelled amounts)',
  (rls_test.get('ov') ->> 'invoiced_total')::numeric = (select sum(grand_total) from public.sales_invoices where company_id = rls_test.id('company_a') and status = 'ISSUED')
  and (rls_test.get('ov') ->> 'invoices_issued')::int = 4 and (rls_test.get('ov') ->> 'received_total')::numeric = 5000, rls_test.get('ov')::text);
select rls_test.claims('viewer');
select rls_test.ok('reports: Management Viewer can read billing reports but not export', private.has_permission(rls_test.id('company_a'), 'billing_reports.read')
  and not private.has_permission(rls_test.id('company_a'), 'billing_reports.export'));
select rls_test.claims('im');
select rls_test.expect_call_error('reports: Inventory Manager cannot open receivables', format($q$ select public.billing_receivables(%L) $q$, rls_test.today()), 'billing_reports.read');
select rls_test.expect_rows('permissions: Inventory Manager can see invoice status', 'select * from public.sales_invoice_list', 6);

-- ===========================================================================
-- CROSS-COMPANY
-- ===========================================================================
select rls_test.claims('b_acc');
select rls_test.expect_rows('cross-company: company B sees no company A invoices, lines, receipts, notes or history',
  'select id from public.sales_invoice_list union all select id from public.sales_invoice_lines union all select id from public.customer_payment_list
   union all select id from public.adjustment_note_list union all select id from public.billing_events', 0);
select rls_test.expect_call_error('cross-company: cannot invoice company A dispatches',
  format($q$ select public.sales_invoice_create_draft(%L::jsonb, '{}'::jsonb, gen_random_uuid()) $q$, jsonb_build_array(jsonb_build_object('fulfilment_line_id', rls_test.id('fl4')))), 'not found');
select rls_test.expect_call_error('cross-company: cannot cancel a company A invoice', format($q$ select public.sales_invoice_action(%L, 'CANCEL', 'xxxxx yyyy') $q$, rls_test.gid('inv5', 'invoice_id')), 'not found');
select rls_test.expect_call_error('cross-company: cannot record a receipt for a company A customer',
  format($q$ select public.customer_payment_record(%L::jsonb, null, gen_random_uuid()) $q$, jsonb_build_object('customer_id', rls_test.id('cu_mh'), 'amount', 1, 'payment_method', 'UPI')), 'customer');
select rls_test.expect_call_error('cross-company: cannot read a company A customer statement', format($q$ select public.billing_customer_statement(%L, %L, %L) $q$, rls_test.id('cu_mh'), rls_test.today() - 1, rls_test.today()), 'not found');

-- ===========================================================================
-- AUDIT
-- ===========================================================================
reset role;
select rls_test.ok('audit: history covers drafts, issue, review, cancellation, payments, allocations, reversals, notes and settings',
  (select array_agg(distinct entity_type || ':' || event_type) from public.billing_events where company_id = rls_test.id('company_a'))
    @> array['INVOICE:DRAFT_CREATED', 'INVOICE:ISSUED', 'INVOICE:ACK_TAX_REVIEW', 'INVOICE:CANCEL', 'INVOICE:DISCARD', 'INVOICE:SUBMIT', 'PAYMENT:RECORDED', 'PAYMENT:REVERSED',
      'ALLOCATION:ALLOCATED', 'ALLOCATION:REVERSED', 'NOTE:ISSUED', 'NOTE:ACK_TAX_REVIEW', 'SETTINGS:UPDATED'],
  (select array_to_string(array_agg(distinct entity_type || ':' || event_type), ',') from public.billing_events where company_id = rls_test.id('company_a')));
select rls_test.ok('audit: every billing event records the acting user', not exists (select 1 from public.billing_events where company_id = rls_test.id('company_a') and actor_user_id is null));
select rls_test.ok('audit: the audit log has the invoice issue entry', exists (select 1 from public.audit_logs where company_id = rls_test.id('company_a') and action = 'billing.invoice.issued'));
select rls_test.expect_error('audit: billing history is append-only (even for the owner)', format($q$ delete from public.billing_events where company_id = %L $q$, rls_test.id('company_a')));
select rls_test.ok('ledger: stock is unchanged by all billing activity (only the Phase 7 dispatch of F2 and the return receipt moved stock)',
  rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx_after_return') #>> '{}')::int);

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
  raise exception 'BILLING_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
