-- =============================================================================
-- SUPPLIER MASTER VERIFICATION
--
-- Executable checks for supplier creation, automatic codes, duplicate
-- protection (code, GSTIN), field validation, immutable columns, RBAC
-- (manage / read-only / no access), cross-company isolation, no deletes, the
-- audit trail and supplier_activity(), the future-PO guard and the products
-- preferred-supplier foreign key.
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction with its own companies (SPA / SPB) and ALWAYS ends
-- by raising SUPPLIER_VERIFICATION_RESULT passed=N failed=M so that all test
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
-- For INSERT/UPDATE ... RETURNING (data-modifying statements must be in a CTE).
create function rls_test.expect_write(p_name text, p_sql text, p_expected int) returns void language plpgsql as $$
declare n int;
begin execute format('with w as (%s) select count(*) from w', p_sql) into n;
  perform rls_test.ok(p_name, n = p_expected, format('rows=%s expected=%s', n, p_expected));
exception when others then perform rls_test.ok(p_name, false, format('unexpected error %s: %s', sqlstate, sqlerrm)); end $$;
create function rls_test.expect_error(p_name text, p_sql text, p_state text default null) returns void language plpgsql as $$
begin execute p_sql; perform rls_test.ok(p_name, false, 'statement succeeded but should have been rejected');
exception when others then perform rls_test.ok(p_name, p_state is null or sqlstate = p_state, format('rejected %s: %s', sqlstate, sqlerrm)); end $$;
create function rls_test.expect_call_ok(p_name text, p_key text, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.set(p_key, r); perform rls_test.ok(p_name, not (r ? 'error'), r::text); return r; end $$;
create function rls_test.claims(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', rls_test.id(p_key), 'role', 'authenticated')::text, true) $$;

-- Owner-side probes (bypass RLS to see the true state)
create function rls_test.sup(p_company uuid, p_code text) returns public.suppliers language sql stable security definer as $$
  select * from public.suppliers where company_id = p_company and supplier_code = p_code $$;
create function rls_test.audit_count(p_supplier uuid, p_action text) returns int language sql stable security definer as $$
  select count(*)::int from public.audit_logs where resource_type = 'supplier' and resource_id = p_supplier::text and action = p_action $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- Insert helper: a minimal valid supplier as the current user.
create function rls_test.ins(p_company uuid, p_fields jsonb) returns text language plpgsql as $$
declare
  v_cols text;
  v_vals text;
begin
  select string_agg(quote_ident(key), ', '), string_agg(quote_nullable(value #>> '{}'), ', ') into v_cols, v_vals
  from jsonb_each(p_fields || jsonb_build_object('company_id', p_company));
  return format('insert into public.suppliers (%s) values (%s) returning to_jsonb(suppliers.*)', v_cols, v_vals);
end $$;
grant execute on function rls_test.ins(uuid, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e57500-0000-4000-8000-0000000000a1'), ('company_b', 'e7e57500-0000-4000-8000-0000000000b1'),
  ('pm', 'e7e57500-0000-4000-8000-000000000002'), ('adm', 'e7e57500-0000-4000-8000-000000000003'),
  ('acct', 'e7e57500-0000-4000-8000-000000000004'), ('inv', 'e7e57500-0000-4000-8000-000000000005'),
  ('viewer', 'e7e57500-0000-4000-8000-000000000006'), ('b_pm', 'e7e57500-0000-4000-8000-000000000007'),
  ('prod_a', 'e7e57500-0000-4000-8000-0000000000c1');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code) values
  (rls_test.id('company_a'), 'Supplier Test A', 'Supplier Test A', 'SPA'), (rls_test.id('company_b'), 'Supplier Test B', 'Supplier Test B', 'SPB');
insert into auth.users (id, email) select id, key || '@sup.example.invalid' from rls_test.ids where key in ('pm', 'adm', 'acct', 'inv', 'viewer', 'b_pm');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true
  where id in (rls_test.id('pm'), rls_test.id('adm'), rls_test.id('acct'), rls_test.id('inv'), rls_test.id('viewer'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_pm');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('pm'),     rls_test.id('company_a'), rls_test.id('role_purchase_manager')),
  (rls_test.id('adm'),    rls_test.id('company_a'), rls_test.id('role_admin')),
  (rls_test.id('acct'),   rls_test.id('company_a'), rls_test.id('role_accounts_manager')),
  (rls_test.id('inv'),    rls_test.id('company_a'), rls_test.id('role_inventory_manager')),
  (rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_management_viewer')),
  (rls_test.id('b_pm'),   rls_test.id('company_b'), rls_test.id('role_purchase_manager'));
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, track_batches, track_expiry, status) values
  (rls_test.id('prod_a'), rls_test.id('company_a'), 'SUP-TEST-1', 'Supplier test product', 'RAW_MATERIAL', 'IN_HOUSE', 'KG', false, false, 'ACTIVE');

select rls_test.ok('schema: RLS is enabled on suppliers', (select relrowsecurity from pg_class where oid = 'public.suppliers'::regclass));
select rls_test.ok('schema: clients have no DELETE privilege on suppliers', not has_table_privilege('authenticated', 'public.suppliers', 'DELETE'));
select rls_test.ok('schema: clients cannot change company_id or supplier_code after creation',
  not has_column_privilege('authenticated', 'public.suppliers', 'company_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.suppliers', 'supplier_code', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.suppliers', 'created_by', 'INSERT'));
select rls_test.ok('schema: anon has no access to suppliers', not has_table_privilege('anon', 'public.suppliers', 'SELECT'));
select rls_test.ok('schema: supplier permissions are the existing seeded ones (no new codes)',
  (select count(*) from public.permissions where code like 'suppliers.%') = 2);
select rls_test.ok('roles: Admin and Purchase Manager manage; Accounts Manager reads only; Inventory Manager / Viewer have no supplier permission',
  private.user_has_role(rls_test.id('pm'), rls_test.id('company_a'), 'PURCHASE_MANAGER')
  and exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id where r.code = 'ADMIN' and p.code = 'suppliers.manage')
  and exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id where r.code = 'ACCOUNTS_MANAGER' and p.code = 'suppliers.read')
  and not exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id where r.code = 'ACCOUNTS_MANAGER' and p.code = 'suppliers.manage')
  and not exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id where r.code in ('INVENTORY_MANAGER', 'MANAGEMENT_VIEWER') and p.code like 'suppliers.%'));

-- ---------------------------------------------------------------------------
-- Create (Purchase Manager)
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('pm');

select rls_test.expect_call_ok('create: Purchase Manager creates a supplier without a code', 's1',
  rls_test.ins(rls_test.id('company_a'), jsonb_build_object('legal_name', '  Shree   Clay Works  Pvt Ltd ', 'category', 'RAW_MATERIAL', 'gstin', '27aapfu0939f1zv',
    'pan', 'AAPFU0939F', 'email', ' Sales@ShreeClay.example ', 'phone', '+91 98200 12345', 'state_code', '27', 'city', 'Pune', 'pin_code', '411001',
    'payment_terms', 'DAYS_30', 'custom_payment_days', '12')));
select rls_test.ok('create: code generated as SUP-000001; names, GSTIN and e-mail normalised; custom days cleared for standard terms',
  rls_test.get('s1') ->> 'supplier_code' = 'SUP-000001' and rls_test.get('s1') ->> 'legal_name' = 'Shree Clay Works Pvt Ltd'
  and rls_test.get('s1') ->> 'gstin' = '27AAPFU0939F1ZV' and rls_test.get('s1') ->> 'email' = 'sales@shreeclay.example'
  and rls_test.get('s1') ->> 'custom_payment_days' is null and rls_test.get('s1') ->> 'country' = 'India' and rls_test.get('s1') ->> 'status' = 'ACTIVE',
  rls_test.get('s1')::text);
select rls_test.ok('create: created_by / updated_by set from the session, not the client',
  rls_test.get('s1') ->> 'created_by' = rls_test.id('pm')::text and rls_test.get('s1') ->> 'updated_by' = rls_test.id('pm')::text);

select rls_test.expect_call_ok('create: a manual code is accepted (upper-cased)', 's_manual',
  rls_test.ins(rls_test.id('company_a'), jsonb_build_object('supplier_code', 'sup-000002', 'legal_name', 'Manual Code Packaging', 'category', 'PACKAGING')));
select rls_test.expect_call_ok('create: next automatic code skips a number already used manually', 's3',
  rls_test.ins(rls_test.id('company_a'), jsonb_build_object('legal_name', 'Kiln Services', 'category', 'SERVICES', 'payment_terms', 'CUSTOM', 'custom_payment_days', '60')));
select rls_test.ok('create: SUP-000002 taken manually -> automatic code is SUP-000003; custom terms keep 60 days',
  rls_test.get('s_manual') ->> 'supplier_code' = 'SUP-000002' and rls_test.get('s3') ->> 'supplier_code' = 'SUP-000003'
  and (rls_test.get('s3') ->> 'custom_payment_days')::int = 60, rls_test.get('s3')::text);

-- Duplicates
select rls_test.expect_error('duplicates: the same supplier code is rejected in one company',
  rls_test.ins(rls_test.id('company_a'), jsonb_build_object('supplier_code', 'SUP-000001', 'legal_name', 'Another')), '23505');
select rls_test.expect_error('duplicates: the same GSTIN is rejected in one company (case-insensitive input)',
  rls_test.ins(rls_test.id('company_a'), jsonb_build_object('legal_name', 'Shree Clay (duplicate)', 'gstin', '27AAPFU0939F1ZV')), '23505');
select rls_test.expect_call_ok('duplicates: several suppliers without a GSTIN are allowed (GSTIN is optional)', 's_nogst',
  rls_test.ins(rls_test.id('company_a'), jsonb_build_object('legal_name', 'Local Transporter')));

-- Validation
select rls_test.expect_error('validation: legal name is required', rls_test.ins(rls_test.id('company_a'), jsonb_build_object('legal_name', '   ')), '23514');
select rls_test.expect_error('validation: malformed GSTIN rejected', rls_test.ins(rls_test.id('company_a'), jsonb_build_object('legal_name', 'X', 'gstin', '27AAPFU0939F1Z')), '23514');
select rls_test.expect_error('validation: malformed PAN rejected', rls_test.ins(rls_test.id('company_a'), jsonb_build_object('legal_name', 'X', 'pan', 'ABCDE12345')), '23514');
select rls_test.expect_error('validation: PAN must match characters 3-12 of the GSTIN',
  rls_test.ins(rls_test.id('company_a'), jsonb_build_object('legal_name', 'X', 'gstin', '24ABCDE1234F1Z5', 'pan', 'ZZZZZ9999Z')), '23514');
select rls_test.expect_error('validation: malformed e-mail rejected', rls_test.ins(rls_test.id('company_a'), jsonb_build_object('legal_name', 'X', 'email', 'not-an-email')), '23514');
select rls_test.expect_error('validation: malformed phone rejected', rls_test.ins(rls_test.id('company_a'), jsonb_build_object('legal_name', 'X', 'phone', '12ab')), '23514');
select rls_test.expect_error('validation: Indian PIN code must be 6 digits', rls_test.ins(rls_test.id('company_a'), jsonb_build_object('legal_name', 'X', 'pin_code', '01234')), '23514');
select rls_test.expect_call_ok('validation: a foreign postcode is allowed when the country is not India', 's_foreign',
  rls_test.ins(rls_test.id('company_a'), jsonb_build_object('legal_name', 'Overseas Glaze GmbH', 'country', 'Germany', 'pin_code', '10115', 'category', 'MACHINERY')));
select rls_test.expect_error('validation: CUSTOM payment terms need a number of days',
  rls_test.ins(rls_test.id('company_a'), jsonb_build_object('legal_name', 'X', 'payment_terms', 'CUSTOM')), '23514');
select rls_test.expect_error('validation: unknown category rejected', rls_test.ins(rls_test.id('company_a'), jsonb_build_object('legal_name', 'X', 'category', 'FOOD')), '23514');

-- ---------------------------------------------------------------------------
-- Edit, immutable columns, deactivate, no delete
-- ---------------------------------------------------------------------------
select rls_test.expect_write('edit: Purchase Manager updates contact details',
  format($q$ update public.suppliers set contact_person = 'R. Patil', display_name = 'Shree Clay' where id = %L returning 1 $q$, rls_test.get('s1') ->> 'id'), 1);
select rls_test.expect_error('edit: supplier_code cannot be changed by clients',
  format($q$ update public.suppliers set supplier_code = 'NEWCODE' where id = %L $q$, rls_test.get('s1') ->> 'id'), '42501');
select rls_test.expect_error('edit: company_id cannot be changed by clients',
  format($q$ update public.suppliers set company_id = %L where id = %L $q$, rls_test.id('company_b'), rls_test.get('s1') ->> 'id'), '42501');
select rls_test.expect_error('edit: changing GSTIN to one already used in the company is rejected',
  format($q$ update public.suppliers set gstin = '27AAPFU0939F1ZV', pan = null where id = %L $q$, rls_test.get('s3') ->> 'id'), '23505');
select rls_test.expect_write('deactivate: Purchase Manager deactivates a supplier',
  format($q$ update public.suppliers set status = 'INACTIVE' where id = %L returning 1 $q$, rls_test.get('s3') ->> 'id'), 1);
select rls_test.expect_error('delete: suppliers cannot be deleted, even by a Purchase Manager',
  format($q$ delete from public.suppliers where id = %L $q$, rls_test.get('s_nogst') ->> 'id'), '42501');

select rls_test.claims('adm');
select rls_test.expect_write('admin: Administrator can edit suppliers',
  format($q$ update public.suppliers set notes = 'Approved vendor' where id = %L returning 1 $q$, rls_test.get('s1') ->> 'id'), 1);

-- ---------------------------------------------------------------------------
-- Read-only and no-access roles
-- ---------------------------------------------------------------------------
select rls_test.claims('acct');
select rls_test.expect_rows('read-only: Accounts Manager sees the company''s suppliers',
  format($q$ select 1 from public.suppliers where company_id = %L $q$, rls_test.id('company_a')), 5);
select rls_test.expect_error('read-only: Accounts Manager cannot create suppliers',
  rls_test.ins(rls_test.id('company_a'), jsonb_build_object('legal_name', 'Accounts Attempt')), '42501');
select rls_test.expect_write('read-only: Accounts Manager update matches no rows',
  format($q$ update public.suppliers set notes = 'changed by accounts' where id = %L returning 1 $q$, rls_test.get('s1') ->> 'id'), 0);

select rls_test.claims('inv');
select rls_test.expect_rows('no access: Inventory Manager sees no suppliers', 'select 1 from public.suppliers', 0);
select rls_test.expect_error('no access: Inventory Manager cannot create suppliers',
  rls_test.ins(rls_test.id('company_a'), jsonb_build_object('legal_name', 'Inventory Attempt')), '42501');
select rls_test.claims('viewer');
-- Management Viewer and Inventory Manager hold purchases.read; that must NOT expose suppliers.
select rls_test.expect_rows('no access: purchases.read alone (Management Viewer) does not expose suppliers', 'select 1 from public.suppliers', 0);
select rls_test.expect_write('no access: Management Viewer update matches no rows',
  format($q$ update public.suppliers set notes = 'viewer' where id = %L returning 1 $q$, rls_test.get('s1') ->> 'id'), 0);

-- ---------------------------------------------------------------------------
-- Cross-company isolation
-- ---------------------------------------------------------------------------
select rls_test.claims('b_pm');
select rls_test.expect_rows('isolation: company B sees none of company A''s suppliers', format($q$ select 1 from public.suppliers where company_id = %L $q$, rls_test.id('company_a')), 0);
select rls_test.expect_rows('isolation: company B cannot read company A''s supplier by id', format($q$ select 1 from public.suppliers where id = %L $q$, rls_test.get('s1') ->> 'id'), 0);
select rls_test.expect_error('isolation: company B cannot create a supplier in company A',
  rls_test.ins(rls_test.id('company_a'), jsonb_build_object('legal_name', 'Cross-company attempt')), '42501');
select rls_test.expect_write('isolation: company B cannot update company A''s supplier',
  format($q$ update public.suppliers set legal_name = 'Hijacked' where id = %L returning 1 $q$, rls_test.get('s1') ->> 'id'), 0);
select rls_test.expect_call_ok('isolation: company B may register the same GSTIN in its own company', 'b1',
  rls_test.ins(rls_test.id('company_b'), jsonb_build_object('legal_name', 'Shree Clay Works Pvt Ltd', 'gstin', '27AAPFU0939F1ZV')));
select rls_test.ok('isolation: supplier codes are numbered per company (B starts at SUP-000001)', rls_test.get('b1') ->> 'supplier_code' = 'SUP-000001', rls_test.get('b1')::text);
select rls_test.expect_error('isolation: company B cannot read company A''s supplier history',
  format($q$ select * from public.supplier_activity(%L) $q$, rls_test.get('s1') ->> 'id'), 'P0001');

-- ---------------------------------------------------------------------------
-- Audit trail and supplier_activity()
-- ---------------------------------------------------------------------------
select rls_test.claims('pm');
select rls_test.expect_rows('history: supplier_activity lists created + 2 edits for SUP-000001',
  format($q$ select 1 from public.supplier_activity(%L) $q$, rls_test.get('s1') ->> 'id'), 3);
select rls_test.ok('history: edit entries record changed field names (not values) and an actor name',
  exists (select 1 from public.supplier_activity((rls_test.get('s1') ->> 'id')::uuid) a
          where a.action = 'supplier.updated' and a.metadata -> 'changed_fields' ? 'contact_person' and a.metadata -> 'changed_fields' ? 'display_name'
            and not (a.metadata ? 'contact_person') and a.actor_name is not null));
select rls_test.claims('acct');
select rls_test.expect_rows('history: Accounts Manager (suppliers.read, no audit_logs.read) can see a supplier''s history',
  format($q$ select 1 from public.supplier_activity(%L) $q$, rls_test.get('s3') ->> 'id'), 2);
select rls_test.claims('inv');
select rls_test.expect_error('history: a user without suppliers.read cannot read it',
  format($q$ select * from public.supplier_activity(%L) $q$, rls_test.get('s1') ->> 'id'), 'P0001');
select rls_test.expect_error('history: private.require_active_supplier is not callable by clients',
  format($q$ select private.require_active_supplier(%L, %L) $q$, rls_test.id('company_a'), rls_test.get('s1') ->> 'id'), '42501');

reset role;
select rls_test.ok('audit: deactivation logged as supplier.deactivated with from/to status',
  rls_test.audit_count((rls_test.get('s3') ->> 'id')::uuid, 'supplier.deactivated') = 1
  and exists (select 1 from public.audit_logs where resource_id = rls_test.get('s3') ->> 'id' and action = 'supplier.deactivated'
              and metadata ->> 'from' = 'ACTIVE' and metadata ->> 'to' = 'INACTIVE'));
select rls_test.ok('audit: rejected writes left no audit entries (exactly 5 created events in company A)',
  (select count(*) from public.audit_logs where company_id = rls_test.id('company_a') and action = 'supplier.created') = 5);
select rls_test.ok('persistence: the unauthorised edits did not change the record',
  (rls_test.sup(rls_test.id('company_a'), 'SUP-000001')).notes = 'Approved vendor'
  and (rls_test.sup(rls_test.id('company_a'), 'SUP-000001')).legal_name = 'Shree Clay Works Pvt Ltd'
  and (rls_test.sup(rls_test.id('company_a'), 'SUP-000001')).supplier_code = 'SUP-000001');

-- ---------------------------------------------------------------------------
-- Purchase order preparation and product foreign key (owner side)
-- ---------------------------------------------------------------------------
select rls_test.ok('PO guard: an active same-company supplier is accepted',
  (private.require_active_supplier(rls_test.id('company_a'), (rls_test.get('s1') ->> 'id')::uuid)).supplier_code = 'SUP-000001');
select rls_test.expect_error('PO guard: an inactive supplier is rejected for new purchase orders',
  format($q$ select private.require_active_supplier(%L, %L) $q$, rls_test.id('company_a'), rls_test.get('s3') ->> 'id'), 'P0001');
select rls_test.expect_error('PO guard: another company''s supplier is rejected',
  format($q$ select private.require_active_supplier(%L, %L) $q$, rls_test.id('company_a'), rls_test.get('b1') ->> 'id'), 'P0001');
select rls_test.expect_error('products FK: a product cannot point at another company''s supplier',
  format($q$ update public.products set preferred_supplier_id = %L where id = %L $q$, rls_test.get('b1') ->> 'id', rls_test.id('prod_a')), '23503');
select rls_test.expect_write('products FK: a product can reference a supplier in its own company',
  format($q$ update public.products set preferred_supplier_id = %L where id = %L returning 1 $q$, rls_test.get('s1') ->> 'id', rls_test.id('prod_a')), 1);
select rls_test.expect_error('products FK: a referenced supplier cannot be hard-deleted (history kept)',
  format($q$ delete from public.suppliers where id = %L $q$, rls_test.get('s1') ->> 'id'), '23001');

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
  raise exception 'SUPPLIER_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
