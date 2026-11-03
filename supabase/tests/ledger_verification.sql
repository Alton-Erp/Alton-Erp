-- =============================================================================
-- UNIFIED LEDGER VERIFICATION (ALTON ERP V2, Stage 2)
--
-- Checks migration 20261103090000_unified_ledger.sql: parties for existing and
-- new customers / suppliers, Customer / Supplier / Both, field mapping, duplicate
-- prevention, role changes that keep history, linking, search, receivable and
-- payable balances (opening, receipts, goods receipts, supplier payments),
-- transaction history, status, permissions and company isolation.
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction and ALWAYS ends by raising
--   LEDGER_VERIFICATION_RESULT passed=N failed=M
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
begin perform rls_test.set(p_key, r); perform rls_test.ok(p_name, not (r ? 'error') and coalesce((r ->> 'ok')::boolean, true), r::text); return r; end $$;
create function rls_test.expect_call_error(p_name text, p_sql text, p_pattern text default null) returns void language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.ok(p_name, r ? 'error' and (p_pattern is null or r ->> 'error' ilike '%' || p_pattern || '%'), r::text); end $$;
create function rls_test.claims(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', rls_test.id(p_key), 'role', 'authenticated')::text, true) $$;
create function rls_test.today() returns date language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;
-- party_save as a SQL string (party json, confirm flag, idempotency key).
create function rls_test.save(p_party uuid, p_data jsonb, p_confirm boolean default false, p_key uuid default null) returns text language sql stable as $$
  select format('select public.party_save(%L, %L::jsonb, %L, %L)', p_party, p_data, p_confirm, coalesce(p_key, gen_random_uuid())) $$;
-- One row of ledger_parties as jsonb (runs as the caller).
create function rls_test.party(p_id uuid) returns jsonb language sql stable as $$
  select to_jsonb(x) from public.ledger_parties(null, null, null, p_id) x $$;
create function rls_test.search(p_term text) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(x.party_code order by x.party_code), '[]'::jsonb) from public.ledger_parties(p_term, null, null) x $$;

-- Owner-side probes (bypass RLS).
create function rls_test.prow(p_id uuid) returns public.parties language sql stable security definer as $$ select * from public.parties where id = p_id $$;
create function rls_test.party_of_customer(p_id uuid) returns public.parties language sql stable security definer as $$ select * from public.parties where customer_id = p_id $$;
create function rls_test.party_of_supplier(p_id uuid) returns public.parties language sql stable security definer as $$ select * from public.parties where supplier_id = p_id $$;
create function rls_test.cust(p_id uuid) returns public.customers language sql stable security definer as $$ select * from public.customers where id = p_id $$;
create function rls_test.sup(p_id uuid) returns public.suppliers language sql stable security definer as $$ select * from public.suppliers where id = p_id $$;
create function rls_test.po_line(p_po uuid) returns uuid language sql stable security definer as $$
  select id from public.purchase_order_lines where purchase_order_id = p_po order by line_no limit 1 $$;
create function rls_test.party_count(p_company uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.parties where company_id = p_company $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5c300-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5c300-0000-4000-8000-0000000000b1'),
  ('op',  'e7e5c300-0000-4000-8000-000000000001'),   -- single operator (Super Admin)
  ('pur', 'e7e5c300-0000-4000-8000-000000000002'),   -- Purchase Manager (suppliers only)
  ('b_op','e7e5c300-0000-4000-8000-000000000003'),
  ('legacy_c', 'e7e5c300-0000-4000-8000-0000000000c1'), ('legacy_s', 'e7e5c300-0000-4000-8000-0000000000c2'),
  ('clay', 'e7e5c300-0000-4000-8000-0000000000d1'), ('w1', 'e7e5c300-0000-4000-8000-0000000000e1');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code, gstin, legal_address, state) values
  (rls_test.id('company_a'), 'Ledger Test A Pvt Ltd', 'Ledger A', 'LGA', '27AAACL1234A1Z5', 'Pune', 'Maharashtra'),
  (rls_test.id('company_b'), 'Ledger Test B', 'Ledger B', 'LGB', null, null, null);
insert into auth.users (id, email) select id, key || '@lg.example.invalid' from rls_test.ids where key in ('op', 'pur', 'b_op');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id in (rls_test.id('op'), rls_test.id('pur'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_op');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('op'),   rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('pur'),  rls_test.id('company_a'), rls_test.id('role_purchase_manager')),
  (rls_test.id('b_op'), rls_test.id('company_b'), rls_test.id('role_super_admin'));

-- Existing (legacy) records created the old way, before the ledger was used.
insert into public.customers (id, company_id, customer_code, customer_name, contact_email, notes) values
  (rls_test.id('legacy_c'), rls_test.id('company_a'), 'DLR-01', 'Shree Sanitary House', 'orders@shree.example', 'Old dealer');
insert into public.suppliers (id, company_id, supplier_code, legal_name, gstin, state_code, payment_terms, phone) values
  (rls_test.id('legacy_s'), rls_test.id('company_a'), 'S-SHREE', 'Shree Sanitary House Pvt. Ltd.', '27AAPFU0939F1ZV', '27', 'DAYS_30', '98200 11111');
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, track_batches, track_expiry, status, hsn_code, gst_rate) values
  (rls_test.id('clay'), rls_test.id('company_a'), 'LG-CLAY', 'Ball clay', 'RAW_MATERIAL', 'OUTSOURCED', 'KG', false, false, 'ACTIVE', '2508', 5);
insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Main', true);
insert into rls_test.ids (key, id) select 'g1', id from public.inventory_locations where warehouse_id = rls_test.id('w1') and location_code = 'GENERAL';

-- ---------------------------------------------------------------------------
-- Schema, permissions, existing data
-- ---------------------------------------------------------------------------
select rls_test.ok('schema: RLS on parties and supplier_payments; clients cannot write them',
  (select bool_and(relrowsecurity) from pg_class where oid in ('public.parties'::regclass, 'public.supplier_payments'::regclass))
  and not has_table_privilege('authenticated', 'public.parties', 'INSERT,UPDATE,DELETE')
  and not has_table_privilege('authenticated', 'public.supplier_payments', 'INSERT,UPDATE,DELETE'));
select rls_test.ok('permissions: ledger.read for every role that can read customers or suppliers',
  not exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id
              where p.code in ('customers.read', 'suppliers.read')
                and not exists (select 1 from public.role_permissions r2 join public.permissions p2 on p2.id = r2.permission_id
                                where r2.role_id = rp.role_id and p2.code = 'ledger.read')));
select rls_test.ok('permissions: supplier_payment.manage for Admin, Accounts, Purchase Manager and Super Admin only',
  (select array_agg(r.code order by r.code) from public.role_permissions rp join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id where p.code = 'supplier_payment.manage')
  = array['ACCOUNTS_MANAGER', 'ADMIN', 'PURCHASE_MANAGER', 'SUPER_ADMIN']);
select rls_test.ok('existing data: a customer and a supplier created the old way each got their own party (nothing merged automatically)',
  (rls_test.party_of_customer(rls_test.id('legacy_c'))).party_code ~ '^PTY-[0-9]{6}$'
  and (rls_test.party_of_supplier(rls_test.id('legacy_s'))).party_code ~ '^PTY-[0-9]{6}$'
  and (rls_test.party_of_customer(rls_test.id('legacy_c'))).id <> (rls_test.party_of_supplier(rls_test.id('legacy_s'))).id
  and (rls_test.party_of_customer(rls_test.id('legacy_c'))).remarks = 'Old dealer');

-- ---------------------------------------------------------------------------
-- Create: Customer, Supplier, Both
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('create: a customer with only a name', 'c1',
  rls_test.save(null, '{"party_type": "CUSTOMER", "party_name": "Walk-in Projects"}'));
select rls_test.ok('create: customer code CUS-000001 and party code assigned automatically',
  rls_test.get('c1') ->> 'customer_code' = 'CUS-000001' and rls_test.get('c1') ->> 'party_code' ~ '^PTY-' and rls_test.get('c1') ->> 'supplier_id' is null,
  rls_test.get('c1')::text);
select rls_test.expect_call_ok('create: a supplier with GSTIN, mobile, address, credit period 45 days and an opening payable', 's1',
  rls_test.save(null, jsonb_build_object('party_type', 'SUPPLIER', 'party_name', 'Morbi Glaze Works', 'gstin', '24ABCDE1234F1Z5',
    'phone', '+91 98250 22222', 'email', 'Accounts@MorbiGlaze.example', 'billing_address', 'GIDC, Morbi', 'city', 'Morbi', 'pin_code', '363642',
    'credit_period_days', 45, 'opening_balance', 2500, 'bank_name', 'HDFC Bank', 'bank_account_number', '50100 1234 5678', 'bank_ifsc', 'hdfc0001234',
    'contact_person', 'R. Patel', 'remarks', 'Glaze and frit')));
reset role;
select rls_test.ok('mapping: state and PAN come from the GSTIN; 45 days -> DAYS_45; e-mail lower-cased; opening balance payable (supplier default)',
  (rls_test.sup(rls_test.gid('s1', 'supplier_id'))).state_code = '24' and (rls_test.sup(rls_test.gid('s1', 'supplier_id'))).pan = 'ABCDE1234F'
  and (rls_test.sup(rls_test.gid('s1', 'supplier_id'))).payment_terms = 'DAYS_45' and (rls_test.sup(rls_test.gid('s1', 'supplier_id'))).email = 'accounts@morbiglaze.example'
  and (rls_test.prow(rls_test.gid('s1', 'party_id'))).opening_balance_type = 'PAYABLE' and (rls_test.prow(rls_test.gid('s1', 'party_id'))).opening_balance = 2500
  and (rls_test.prow(rls_test.gid('s1', 'party_id'))).bank_account_number = '5010012345678' and (rls_test.prow(rls_test.gid('s1', 'party_id'))).bank_ifsc = 'HDFC0001234');
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('create: a party that is BOTH customer and supplier, 20 days credit, opening receivable 1000', 'b1',
  rls_test.save(null, jsonb_build_object('party_type', 'BOTH', 'party_name', 'Aqua Fittings LLP', 'gstin', '27AAQFA1234B1Z2', 'phone', '9822033333',
    'billing_address', 'Bhosari, Pune', 'shipping_address', 'Chakan, Pune', 'credit_period_days', 20, 'opening_balance', 1000, 'opening_balance_type', 'RECEIVABLE')));
reset role;
select rls_test.ok('both: one party, one customer and one supplier with the same name, GSTIN and phone; 20 days -> custom terms',
  rls_test.gid('b1', 'customer_id') is not null and rls_test.gid('b1', 'supplier_id') is not null
  and (rls_test.cust(rls_test.gid('b1', 'customer_id'))).customer_name = 'Aqua Fittings LLP' and (rls_test.sup(rls_test.gid('b1', 'supplier_id'))).legal_name = 'Aqua Fittings LLP'
  and (rls_test.cust(rls_test.gid('b1', 'customer_id'))).gstin = '27AAQFA1234B1Z2' and (rls_test.sup(rls_test.gid('b1', 'supplier_id'))).gstin = '27AAQFA1234B1Z2'
  and (rls_test.cust(rls_test.gid('b1', 'customer_id'))).payment_terms_days = 20 and (rls_test.sup(rls_test.gid('b1', 'supplier_id'))).payment_terms = 'CUSTOM'
  and (rls_test.sup(rls_test.gid('b1', 'supplier_id'))).custom_payment_days = 20 and (rls_test.cust(rls_test.gid('b1', 'customer_id'))).gst_registration_type = 'REGISTERED'
  and (rls_test.cust(rls_test.gid('b1', 'customer_id'))).shipping_address = 'Chakan, Pune'
  and (rls_test.party_of_customer(rls_test.gid('b1', 'customer_id'))).id = rls_test.gid('b1', 'party_id')
  and (rls_test.party_of_supplier(rls_test.gid('b1', 'supplier_id'))).id = rls_test.gid('b1', 'party_id'));
set local role authenticated;
select rls_test.claims('op');
select rls_test.ok('list: the Both party shows type BOTH, state name, credit period and opening receivable as its balance',
  rls_test.party(rls_test.gid('b1', 'party_id')) ->> 'party_type' = 'BOTH' and rls_test.party(rls_test.gid('b1', 'party_id')) ->> 'state_name' = 'Maharashtra'
  and (rls_test.party(rls_test.gid('b1', 'party_id')) ->> 'credit_period_days')::int = 20
  and (rls_test.party(rls_test.gid('b1', 'party_id')) ->> 'receivable')::numeric = 1000 and (rls_test.party(rls_test.gid('b1', 'party_id')) ->> 'payable')::numeric = 0,
  rls_test.party(rls_test.gid('b1', 'party_id'))::text);
select rls_test.expect_call_ok('idempotency: a create with a request id (duplicate name confirmed)', 'c2',
  rls_test.save(null, '{"party_type": "CUSTOMER", "party_name": "Walk-in Projects"}', true, 'e7e5c300-0000-4000-8000-00000000f001'));
select rls_test.expect_call_ok('idempotency: the same request again (double click)', 'c2_retry',
  rls_test.save(null, '{"party_type": "CUSTOMER", "party_name": "Walk-in Projects"}', true, 'e7e5c300-0000-4000-8000-00000000f001'));
reset role;
select rls_test.ok('idempotency: ...returns the first party; no second customer is created',
  rls_test.get('c2_retry') ->> 'party_id' = rls_test.get('c2') ->> 'party_id'
  and (select count(*) from public.customers where company_id = rls_test.id('company_a') and customer_name = 'Walk-in Projects') = 2,
  rls_test.get('c2_retry')::text);
set local role authenticated;
select rls_test.claims('op');

-- ---------------------------------------------------------------------------
-- Validation
-- ---------------------------------------------------------------------------
select rls_test.expect_call_error('validation: party type is required', rls_test.save(null, '{"party_name": "X"}'), 'Customer, a Supplier or Both');
select rls_test.expect_call_error('validation: name is required', rls_test.save(null, '{"party_type": "CUSTOMER", "party_name": "  "}'), 'party name');
select rls_test.expect_call_error('validation: invalid GSTIN', rls_test.save(null, '{"party_type": "CUSTOMER", "party_name": "X", "gstin": "27ABC"}'), 'not valid');
select rls_test.expect_call_error('validation: PAN must match the GSTIN',
  rls_test.save(null, '{"party_type": "CUSTOMER", "party_name": "X", "gstin": "27AAQFX1234B1Z2", "pan": "ZZZZZ9999Z"}'), 'does not match');
select rls_test.expect_call_error('validation: an opening balance of a Both party needs its type',
  rls_test.save(null, '{"party_type": "BOTH", "party_name": "Y", "opening_balance": 50}'), 'receivable');
select rls_test.expect_call_error('validation: Indian PIN code must be 6 digits', rls_test.save(null, '{"party_type": "CUSTOMER", "party_name": "Z", "pin_code": "0123"}'), 'PIN');
select rls_test.expect_call_error('validation: invalid mobile', rls_test.save(null, '{"party_type": "SUPPLIER", "party_name": "Z", "phone": "12"}'), 'Mobile');

-- ---------------------------------------------------------------------------
-- Duplicates
-- ---------------------------------------------------------------------------
select rls_test.expect_call_error('duplicates: the same GSTIN as an existing supplier is refused',
  rls_test.save(null, '{"party_type": "CUSTOMER", "party_name": "Shree New", "gstin": "27AAPFU0939F1ZV"}'), 'already used by party');
select rls_test.set('dup_name', rls_test.call(rls_test.save(null, '{"party_type": "SUPPLIER", "party_name": "Morbi Glaze Works Pvt Ltd"}')));
select rls_test.ok('duplicates: a similar name (company suffix ignored) is returned as a warning and nothing is saved',
  (rls_test.get('dup_name') ->> 'ok') = 'false' and rls_test.get('dup_name') -> 'duplicates' -> 0 -> 'matched_on' ? 'name'
  and rls_test.get('dup_name') -> 'duplicates' -> 0 ->> 'party_id' = rls_test.get('s1') ->> 'party_id', rls_test.get('dup_name')::text);
select rls_test.set('dup_phone', rls_test.call(rls_test.save(null, '{"party_type": "CUSTOMER", "party_name": "Somebody Else", "phone": "098250-22222"}')));
select rls_test.ok('duplicates: the same mobile number in another format is found',
  rls_test.get('dup_phone') -> 'duplicates' -> 0 -> 'matched_on' ? 'mobile', rls_test.get('dup_phone')::text);
select rls_test.expect_call_ok('duplicates: the user can confirm and save it anyway', 'dup_ok',
  rls_test.save(null, '{"party_type": "CUSTOMER", "party_name": "Somebody Else", "phone": "098250-22222"}', true));
select rls_test.set('self_edit', rls_test.call(rls_test.save(rls_test.gid('s1', 'party_id'), jsonb_build_object('party_type', 'SUPPLIER', 'party_name', 'Morbi Glaze Works',
    'gstin', '24ABCDE1234F1Z5', 'phone', '+91 98250 22222', 'credit_period_days', 45, 'opening_balance', 2500, 'remarks', 'Glaze and frit'))));
select rls_test.ok('duplicates: editing a party never lists the party itself (only the other party with the same mobile)',
  not (rls_test.get('self_edit') ? 'error')
  and not exists (select 1 from jsonb_array_elements(coalesce(rls_test.get('self_edit') -> 'duplicates', '[]')) d where d ->> 'party_id' = rls_test.get('s1') ->> 'party_id')
  and exists (select 1 from jsonb_array_elements(coalesce(rls_test.get('self_edit') -> 'duplicates', '[]')) d where d ->> 'party_id' = rls_test.get('dup_ok') ->> 'party_id'),
  rls_test.get('self_edit')::text);

-- ---------------------------------------------------------------------------
-- Search
-- ---------------------------------------------------------------------------
select rls_test.ok('search: by name, GSTIN, mobile digits, party code and customer code',
  rls_test.search('aqua') = jsonb_build_array(rls_test.get('b1') ->> 'party_code')
  and rls_test.search('24ABCDE') = jsonb_build_array(rls_test.get('s1') ->> 'party_code')
  and rls_test.search('98220 33333') = jsonb_build_array(rls_test.get('b1') ->> 'party_code')
  and rls_test.search(rls_test.get('c1') ->> 'party_code') = jsonb_build_array(rls_test.get('c1') ->> 'party_code')
  and rls_test.search('CUS-000001') = jsonb_build_array(rls_test.get('c1') ->> 'party_code'),
  concat_ws(' | ', rls_test.search('aqua'), rls_test.search('24ABCDE'), rls_test.search('98220 33333')));
select rls_test.ok('filters: type and status',
  (select count(*) from public.ledger_parties(null, 'BOTH', null)) = 1
  and (select bool_and(party_type = 'SUPPLIER') from public.ledger_parties(null, 'SUPPLIER', null))
  and (select count(*) from public.ledger_parties(null, null, 'INACTIVE')) = 0);

-- ---------------------------------------------------------------------------
-- Role changes keep history
-- ---------------------------------------------------------------------------
select rls_test.expect_call_ok('roles: the Both party stops being a supplier', 'b1_cust',
  rls_test.save(rls_test.gid('b1', 'party_id'), jsonb_build_object('party_type', 'CUSTOMER', 'party_name', 'Aqua Fittings LLP', 'gstin', '27AAQFA1234B1Z2',
    'phone', '9822033333', 'billing_address', 'Bhosari, Pune', 'shipping_address', 'Chakan, Pune', 'credit_period_days', 20, 'opening_balance', 1000)));
reset role;
select rls_test.ok('roles: the supplier record is deactivated, not deleted; the party keeps the link',
  (rls_test.sup(rls_test.gid('b1', 'supplier_id'))).status = 'INACTIVE' and (rls_test.prow(rls_test.gid('b1', 'party_id'))).supplier_id = rls_test.gid('b1', 'supplier_id')
  and not (rls_test.prow(rls_test.gid('b1', 'party_id'))).is_supplier and (rls_test.prow(rls_test.gid('b1', 'party_id'))).opening_balance_type = 'RECEIVABLE');
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('roles: making it Both again', 'b1_both',
  rls_test.save(rls_test.gid('b1', 'party_id'), jsonb_build_object('party_type', 'BOTH', 'party_name', 'Aqua Fittings LLP', 'gstin', '27AAQFA1234B1Z2',
    'phone', '9822033333', 'credit_period_days', 20, 'opening_balance', 1000, 'opening_balance_type', 'RECEIVABLE')));
reset role;
select rls_test.ok('roles: ...reactivates the same supplier record (no new supplier)',
  rls_test.gid('b1_both', 'supplier_id') = rls_test.gid('b1', 'supplier_id') and (rls_test.sup(rls_test.gid('b1', 'supplier_id'))).status = 'ACTIVE');

-- ---------------------------------------------------------------------------
-- Linking two existing records of the same business
-- ---------------------------------------------------------------------------
insert into rls_test.ids values ('lc_party', (rls_test.party_of_customer(rls_test.id('legacy_c'))).id), ('ls_party', (rls_test.party_of_supplier(rls_test.id('legacy_s'))).id);
set local role authenticated;
select rls_test.claims('op');
select rls_test.set('lc_dups', (select coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) from public.party_find_duplicates('Shree Sanitary House', null, null, null, null, rls_test.id('lc_party')) d));
select rls_test.ok('link: the legacy supplier is suggested as a possible duplicate of the legacy customer',
  rls_test.get('lc_dups') -> 0 ->> 'party_id' = rls_test.id('ls_party')::text, rls_test.get('lc_dups')::text);
select rls_test.expect_call_ok('link: the two parties are linked into one', 'link',
  format('select public.party_link(%L, %L)', rls_test.id('lc_party'), rls_test.id('ls_party')));
reset role;
select rls_test.ok('link: one party with both roles; the customer and supplier records (and their codes) are unchanged',
  (rls_test.party_of_customer(rls_test.id('legacy_c'))).id = (rls_test.party_of_supplier(rls_test.id('legacy_s'))).id
  and not exists (select 1 from public.parties where id = rls_test.id('ls_party'))
  and (rls_test.cust(rls_test.id('legacy_c'))).customer_code = 'DLR-01' and (rls_test.sup(rls_test.id('legacy_s'))).supplier_code = 'S-SHREE');
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_error('link: two customers cannot be linked',
  format('select public.party_link(%L, %L)', rls_test.gid('c1', 'party_id'), rls_test.gid('dup_ok', 'party_id')), 'same role');

-- ---------------------------------------------------------------------------
-- Balances: receipts, goods receipts, supplier payments
-- ---------------------------------------------------------------------------
reset role;
insert into public.customer_payments (company_id, receipt_number, customer_id, receipt_date, amount_received, currency, payment_method, recorded_by)
values (rls_test.id('company_a'), 'RCPT-T-1', rls_test.gid('b1', 'customer_id'), rls_test.today(), 300, 'INR', 'UPI', rls_test.id('op'));
set local role authenticated;
select rls_test.claims('op');
select rls_test.ok('receivable: opening 1000 minus a recorded receipt of 300 = 700',
  (rls_test.party(rls_test.gid('b1', 'party_id')) ->> 'receivable')::numeric = 700, rls_test.party(rls_test.gid('b1', 'party_id'))::text);

-- Purchase order of 100 KG clay at 12 + 5% GST (intra-state) from the Both party, 60 KG received.
select rls_test.expect_call_ok('payable: purchase order from the Both party', 'po',
  format('select public.purchase_order_save(null, %L::jsonb, %L::jsonb, null, %L)',
    jsonb_build_object('supplier_id', rls_test.gid('b1', 'supplier_id'), 'purchase_type', 'RAW_MATERIAL', 'warehouse_id', rls_test.id('w1')),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('clay'), 'quantity', 100, 'unit_price', 12)), gen_random_uuid()));
select rls_test.call(format('select public.purchase_order_open(%L)', rls_test.gid('po', 'po_id')));
reset role;
select rls_test.set('po_line', to_jsonb(rls_test.po_line(rls_test.gid('po', 'po_id'))));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('payable: 60 KG received', 'grn',
  format('select public.purchase_receipt_post(%L, %L::jsonb, %L::jsonb, %L)', rls_test.gid('po', 'po_id'),
    jsonb_build_object('receipt_date', rls_test.today()::text),
    jsonb_build_array(jsonb_build_object('po_line_id', rls_test.get('po_line') #>> '{}', 'received_quantity', 60, 'accepted_quantity', 60,
      'rejected_quantity', 0, 'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()));
select rls_test.ok('payable: 60 of 100 KG of a 1260.00 line (1200 + 5% GST) = 756.00; receivable unchanged',
  (rls_test.party(rls_test.gid('b1', 'party_id')) ->> 'payable')::numeric = 756 and (rls_test.party(rls_test.gid('b1', 'party_id')) ->> 'receivable')::numeric = 700
  and (rls_test.party(rls_test.gid('b1', 'party_id')) ->> 'net_balance')::numeric = -56, rls_test.party(rls_test.gid('b1', 'party_id'))::text);
select rls_test.expect_call_ok('supplier payment: 500 paid by bank transfer', 'pay1',
  format($q$ select public.supplier_payment_record(%L, %L, 500, 'BANK_TRANSFER', 'NEFT-1', null, 'e7e5c300-0000-4000-8000-00000000f002') $q$, rls_test.gid('b1', 'supplier_id'), rls_test.today()));
select rls_test.ok('supplier payment: number SPAY-000001, payable now 256',
  rls_test.get('pay1') ->> 'payment_number' = 'SPAY-000001' and (rls_test.get('pay1') ->> 'payable_after')::numeric = 256
  and (rls_test.party(rls_test.gid('b1', 'party_id')) ->> 'payable')::numeric = 256, rls_test.get('pay1')::text);
select rls_test.expect_call_ok('supplier payment: a retry with the same request id', 'pay1_retry',
  format($q$ select public.supplier_payment_record(%L, %L, 500, 'BANK_TRANSFER', 'NEFT-1', null, 'e7e5c300-0000-4000-8000-00000000f002') $q$, rls_test.gid('b1', 'supplier_id'), rls_test.today()));
select rls_test.ok('supplier payment: ...does not pay twice', (rls_test.party(rls_test.gid('b1', 'party_id')) ->> 'payable')::numeric = 256);
select rls_test.expect_call_error('supplier payment: amount must be positive',
  format($q$ select public.supplier_payment_record(%L, %L, 0, 'CASH', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('b1', 'supplier_id'), rls_test.today()), 'greater than zero');
select rls_test.expect_call_error('supplier payment: a reversal needs a reason',
  format($q$ select public.supplier_payment_reverse(%L, 'x') $q$, rls_test.gid('pay1', 'payment_id')), 'reason');
select rls_test.expect_call_ok('supplier payment: reversed with a reason', 'pay1_rev',
  format($q$ select public.supplier_payment_reverse(%L, 'Bounced transfer') $q$, rls_test.gid('pay1', 'payment_id')));
select rls_test.ok('supplier payment: reversal restores the payable to 756', (rls_test.party(rls_test.gid('b1', 'party_id')) ->> 'payable')::numeric = 756);
reset role;
select rls_test.ok('supplier payment: records cannot be deleted or edited',
  (rls_test.call(format('delete from public.supplier_payments where id = %L returning 1', rls_test.gid('pay1', 'payment_id'))) ? 'error')
  and (rls_test.call(format('update public.supplier_payments set amount = 1 where id = %L returning 1', rls_test.gid('pay1', 'payment_id'))) ? 'error'));

-- ---------------------------------------------------------------------------
-- Transaction history
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('op');
select rls_test.set('tx', public.party_transactions(rls_test.gid('b1', 'party_id')));
select rls_test.ok('history: opening, receipt, purchase order, goods receipt, payment and its reversal are all listed',
  (select array_agg(e ->> 'kind' order by e ->> 'kind') from jsonb_array_elements(rls_test.get('tx') -> 'entries') e)
  = array['GOODS_RECEIPT', 'OPENING', 'PURCHASE_ORDER', 'RECEIPT', 'SUPPLIER_PAYMENT', 'SUPPLIER_PAYMENT_REVERSED'], rls_test.get('tx')::text);
select rls_test.ok('history: the newest entry carries the final running balances (receivable 700, payable 756)',
  (rls_test.get('tx') -> 'entries' -> 0 ->> 'receivable_balance')::numeric = 700 and (rls_test.get('tx') -> 'entries' -> 0 ->> 'payable_balance')::numeric = 756,
  (rls_test.get('tx') -> 'entries' -> 0)::text);

-- ---------------------------------------------------------------------------
-- Status
-- ---------------------------------------------------------------------------
select rls_test.expect_call_ok('status: deactivate the Both party', 'off', format($q$ select public.party_set_status(%L, 'INACTIVE') $q$, rls_test.gid('b1', 'party_id')));
reset role;
select rls_test.ok('status: both roles inactive; the party is listed as inactive',
  (rls_test.cust(rls_test.gid('b1', 'customer_id'))).status = 'INACTIVE' and (rls_test.sup(rls_test.gid('b1', 'supplier_id'))).status = 'INACTIVE');
set local role authenticated;
select rls_test.claims('op');
select rls_test.ok('status: filter by inactive', (select array_agg(party_code) from public.ledger_parties(null, null, 'INACTIVE')) = array[rls_test.get('b1') ->> 'party_code']);
select rls_test.call(format($q$ select public.party_set_status(%L, 'ACTIVE') $q$, rls_test.gid('b1', 'party_id')));

-- ---------------------------------------------------------------------------
-- Permissions, isolation, self-healing
-- ---------------------------------------------------------------------------
select rls_test.claims('pur');
select rls_test.expect_call_error('permissions: a Purchase Manager cannot create a customer',
  rls_test.save(null, '{"party_type": "CUSTOMER", "party_name": "PM Customer"}'), 'customers.manage');
select rls_test.expect_call_ok('permissions: ...but can create a supplier', 'pm_sup', rls_test.save(null, '{"party_type": "SUPPLIER", "party_name": "PM Supplier"}'));
select rls_test.ok('permissions: the Purchase Manager sees supplier-side parties only (no customer-only party, no receivables)',
  not exists (select 1 from public.ledger_parties() x where x.party_type = 'CUSTOMER' or x.receivable <> 0)
  and exists (select 1 from public.ledger_parties() x where x.party_id = rls_test.gid('b1', 'party_id') and x.party_type = 'SUPPLIER'));
select rls_test.claims('b_op');
select rls_test.ok('isolation: company B sees no party of company A', not exists (select 1 from public.ledger_parties()) and not exists (select 1 from public.parties));
select rls_test.expect_call_error('isolation: company B cannot edit company A''s party',
  rls_test.save(rls_test.gid('b1', 'party_id'), '{"party_type": "CUSTOMER", "party_name": "Hijack"}'), 'not found');
select rls_test.expect_call_error('isolation: ...nor read its history', format('select public.party_transactions(%L)', rls_test.gid('b1', 'party_id')), 'not found');
select rls_test.expect_call_error('isolation: ...nor pay its supplier',
  format($q$ select public.supplier_payment_record(%L, %L, 10, 'CASH', p_idempotency_key => gen_random_uuid()) $q$, rls_test.gid('b1', 'supplier_id'), rls_test.today()), 'not found');
reset role;
select set_config('app.ledger_sync', 'on', true);
insert into public.customers (company_id, customer_code, customer_name) values (rls_test.id('company_a'), 'ORPHAN', 'Orphan Customer');
select set_config('app.ledger_sync', '', true);
select rls_test.set('count_before', to_jsonb(rls_test.party_count(rls_test.id('company_a'))));
set local role authenticated;
select rls_test.claims('op');
select rls_test.expect_call_ok('self-healing: a customer without a party gets one when the ledger opens', 'sync', 'select public.ledger_sync_parties()');
reset role;
select rls_test.ok('self-healing: exactly one party added', (rls_test.get('sync') ->> 'customers_added')::int = 1
  and rls_test.party_count(rls_test.id('company_a')) = (rls_test.get('count_before') #>> '{}')::bigint + 1);
select rls_test.ok('grants: anon cannot call the ledger functions',
  not has_function_privilege('anon', 'public.party_save(uuid, jsonb, boolean, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.ledger_parties(text, text, text, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.supplier_payment_record(uuid, date, numeric, text, text, text, uuid)', 'EXECUTE'));

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
  raise exception 'LEDGER_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
