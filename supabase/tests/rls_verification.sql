-- =============================================================================
-- RLS / RBAC VERIFICATION
--
-- Executable security checks for the Phase 2 schema. Run it:
--   * locally:  npm run test:db           (PGlite + tests/db/run-rls-tests.mjs)
--   * on Supabase: paste the whole file into Dashboard > SQL Editor and run.
--
-- Everything happens inside ONE transaction. It creates its own test companies
-- (TESTA, TESTB) and test users (@example.invalid), switches to the real API
-- roles (anon / authenticated) with simulated JWT claims, and records results.
--
-- The script ALWAYS ends by raising an exception containing the summary, e.g.
--   RLS_VERIFICATION_RESULT passed=58 failed=0
-- That error is intentional: it aborts the transaction so no test data is ever
-- left behind. "failed=0" means every check passed.
--
-- Requires the migrations to be applied first. Never disables RLS.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Test harness (schema rls_test, rolled back at the end)
-- -----------------------------------------------------------------------------
create schema rls_test;
grant usage on schema rls_test to anon, authenticated;

create table rls_test.results (
  id     serial primary key,
  name   text not null,
  passed boolean not null,
  detail text
);
grant select, insert on rls_test.results to anon, authenticated;
grant usage on sequence rls_test.results_id_seq to anon, authenticated;

create table rls_test.ids (key text primary key, id uuid not null);
grant select on rls_test.ids to anon, authenticated;

create function rls_test.id(p_key text) returns uuid language sql stable as $$
  select id from rls_test.ids where key = p_key
$$;

create function rls_test.ok(p_name text, p_cond boolean, p_detail text default null) returns void
language plpgsql as $$
begin
  insert into rls_test.results (name, passed, detail) values (p_name, coalesce(p_cond, false), p_detail);
end $$;

-- Passes when the query returns exactly p_expected rows.
create function rls_test.expect_rows(p_name text, p_sql text, p_expected int) returns void
language plpgsql as $$
declare n int;
begin
  execute format('select count(*) from (%s) q', p_sql) into n;
  perform rls_test.ok(p_name, n = p_expected, format('rows=%s expected=%s', n, p_expected));
exception when others then
  perform rls_test.ok(p_name, false, format('unexpected error %s: %s', sqlstate, sqlerrm));
end $$;

-- Passes when the statement succeeds and affects exactly p_expected rows.
create function rls_test.expect_affected(p_name text, p_sql text, p_expected int) returns void
language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  perform rls_test.ok(p_name, n = p_expected, format('affected=%s expected=%s', n, p_expected));
exception when others then
  perform rls_test.ok(p_name, false, format('unexpected error %s: %s', sqlstate, sqlerrm));
end $$;

-- Passes when the statement raises an error (its effects are rolled back).
create function rls_test.expect_error(p_name text, p_sql text) returns void
language plpgsql as $$
begin
  execute p_sql;
  perform rls_test.ok(p_name, false, 'statement succeeded but should have been rejected');
exception when others then
  perform rls_test.ok(p_name, true, format('rejected %s: %s', sqlstate, sqlerrm));
end $$;

-- Passes when the statement is rejected OR silently affects/returns no rows
-- (RLS filters rows rather than raising for UPDATE/DELETE/SELECT).
create function rls_test.expect_blocked(p_name text, p_sql text) returns void
language plpgsql as $$
declare n int;
begin
  if p_sql ~* '^\s*select' then
    execute format('select count(*) from (%s) q', p_sql) into n;
  else
    execute p_sql;
    get diagnostics n = row_count;
  end if;
  perform rls_test.ok(p_name, n = 0, format('not rejected; rows=%s', n));
exception when others then
  perform rls_test.ok(p_name, true, format('rejected %s: %s', sqlstate, sqlerrm));
end $$;

grant execute on all functions in schema rls_test to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Fixtures (as the database owner)
-- -----------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e57000-0000-4000-8000-0000000000a1'),
  ('company_b', 'e7e57000-0000-4000-8000-0000000000b1'),
  ('sa',        'e7e57000-0000-4000-8000-000000000001'),  -- Super Admin, company A
  ('admin',     'e7e57000-0000-4000-8000-000000000002'),  -- Admin, company A
  ('inv',       'e7e57000-0000-4000-8000-000000000003'),  -- Inventory Manager, company A
  ('viewer',    'e7e57000-0000-4000-8000-000000000004'),  -- Management Viewer, company A
  ('inactive',  'e7e57000-0000-4000-8000-000000000005'),  -- Admin role but deactivated, company A
  ('pending',   'e7e57000-0000-4000-8000-000000000006'),  -- fresh signup with malicious metadata
  ('noprofile', 'e7e57000-0000-4000-8000-000000000007'),  -- auth user whose profile is missing
  ('b_admin',   'e7e57000-0000-4000-8000-000000000008'),  -- Admin, company B
  ('sales',     'e7e57000-0000-4000-8000-000000000009'),  -- Sales Manager, company A (products: read/export only)
  ('cat_a',     'e7e57000-0000-4000-8000-0000000000c1'),  -- active category, company A
  ('cat_a_old', 'e7e57000-0000-4000-8000-0000000000c2'),  -- inactive category, company A
  ('cat_b',     'e7e57000-0000-4000-8000-0000000000c3');  -- active category, company B

insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code) values
  (rls_test.id('company_a'), 'RLS Test Company A', 'RLS Test A', 'TESTA'),
  (rls_test.id('company_b'), 'RLS Test Company B', 'RLS Test B', 'TESTB');

insert into public.company_settings (company_id, setting_key, setting_value) values
  (rls_test.id('company_a'), 'test.secret_a', '"a-only"'),
  (rls_test.id('company_b'), 'test.secret_b', '"b-only"');

-- Auth users (the on_auth_user_created trigger creates inactive profiles).
insert into auth.users (id, email, raw_user_meta_data)
select id, key || '@example.invalid', '{}'::jsonb
from rls_test.ids where key in ('sa', 'admin', 'inv', 'viewer', 'inactive', 'noprofile', 'b_admin', 'sales');

-- A signup that tries to smuggle privileges through user metadata.
insert into auth.users (id, email, raw_user_meta_data) values (
  rls_test.id('pending'), 'pending@example.invalid',
  jsonb_build_object('full_name', 'Pending User', 'company_id', rls_test.id('company_a'),
                     'role', 'SUPER_ADMIN', 'is_active', true));

delete from public.profiles where id = rls_test.id('noprofile');

-- Bootstrap Super Admin for company A through the trusted procedure.
select private.bootstrap_super_admin('sa@example.invalid', 'TESTA');

update public.profiles set company_id = rls_test.id('company_a'), is_active = true
  where id in (rls_test.id('admin'), rls_test.id('inv'), rls_test.id('viewer'), rls_test.id('sales'));
update public.profiles set company_id = rls_test.id('company_a'), is_active = false
  where id = rls_test.id('inactive');
update public.profiles set company_id = rls_test.id('company_b'), is_active = true
  where id = rls_test.id('b_admin');

insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('admin'),    rls_test.id('company_a'), rls_test.id('role_admin')),
  (rls_test.id('inv'),      rls_test.id('company_a'), rls_test.id('role_inventory_manager')),
  (rls_test.id('viewer'),   rls_test.id('company_a'), rls_test.id('role_management_viewer')),
  (rls_test.id('inactive'), rls_test.id('company_a'), rls_test.id('role_admin')),
  (rls_test.id('b_admin'),  rls_test.id('company_b'), rls_test.id('role_admin')),
  (rls_test.id('sales'),    rls_test.id('company_a'), rls_test.id('role_sales_manager'));

-- Product categories (Phase 3)
insert into public.product_categories (id, company_id, code, name, is_active) values
  (rls_test.id('cat_a'),     rls_test.id('company_a'), 'TEST_CLOSETS', 'Test Closets', true),
  (rls_test.id('cat_a_old'), rls_test.id('company_a'), 'TEST_OLD',     'Test Retired', false),
  (rls_test.id('cat_b'),     rls_test.id('company_b'), 'TEST_CLOSETS', 'Test Closets', true);

-- -----------------------------------------------------------------------------
-- Structural checks (as owner)
-- -----------------------------------------------------------------------------
select rls_test.ok('RLS enabled on every Phase 2 table',
  (select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in
     ('companies','company_settings','profiles','roles','permissions','role_permissions','user_roles','audit_logs'))
  and (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname in
         ('companies','company_settings','profiles','roles','permissions','role_permissions','user_roles','audit_logs')) = 8);

select rls_test.ok('RLS enabled on every table in schema public',
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity),
  (select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity));

select rls_test.ok('anon has no privileges on any Phase 2 table',
  not exists (select 1 from unnest(array['companies','company_settings','profiles','roles','permissions',
                                         'role_permissions','user_roles','audit_logs']) t
              where has_table_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE')));

select rls_test.ok('No policy grants unconditional access (USING true / WITH CHECK true)',
  not exists (select 1 from pg_policies where schemaname = 'public'
              and (btrim(coalesce(qual, '')) = 'true' or btrim(coalesce(with_check, '')) = 'true')));

select rls_test.ok('anon cannot execute private helper functions',
  not has_function_privilege('anon', 'private.has_permission(uuid, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'private.current_company_id()', 'EXECUTE'));

select rls_test.ok('Bootstrap function is not executable by API roles',
  not has_function_privilege('authenticated', 'private.bootstrap_super_admin(text, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'private.bootstrap_super_admin(text, text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.bootstrap_super_admin(text, text)', 'EXECUTE'));

select rls_test.ok('Signup metadata cannot grant company, activation or roles',
  (select company_id is null and not is_active and full_name = 'Pending User'
   from public.profiles where id = rls_test.id('pending'))
  and not exists (select 1 from public.user_roles where user_id = rls_test.id('pending')));

select rls_test.expect_error('Bootstrap refuses a second Super Admin for the same company',
  $q$ select private.bootstrap_super_admin('admin@example.invalid', 'TESTA') $q$);

select rls_test.expect_error('Role assignment must match company membership (FK)',
  format($q$ insert into public.user_roles (user_id, company_id, role_id) values (%L, %L, %L) $q$,
         rls_test.id('b_admin'), rls_test.id('company_a'), rls_test.id('role_admin')));

select rls_test.ok('Management Viewer holds only read permissions',
  not exists (select 1 from public.role_permissions rp
              join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id
              where r.code = 'MANAGEMENT_VIEWER' and p.action <> 'read'));

select rls_test.ok('Inventory Manager does not hold users.manage',
  not exists (select 1 from public.role_permissions rp
              join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id
              where r.code = 'INVENTORY_MANAGER' and p.code = 'users.manage'));

select rls_test.expect_error('Audit log is append-only even for the owner (UPDATE)',
  $q$ update public.audit_logs set action = 'tampered.event' $q$);
select rls_test.expect_error('Audit log is append-only even for the owner (DELETE)',
  $q$ delete from public.audit_logs $q$);

-- -----------------------------------------------------------------------------
-- Anonymous visitor
-- -----------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

select rls_test.expect_blocked('anon: cannot read companies',        'select * from public.companies');
select rls_test.expect_blocked('anon: cannot read profiles',         'select * from public.profiles');
select rls_test.expect_blocked('anon: cannot read user_roles',       'select * from public.user_roles');
select rls_test.expect_blocked('anon: cannot read company_settings', 'select * from public.company_settings');
select rls_test.expect_blocked('anon: cannot read audit_logs',       'select * from public.audit_logs');
select rls_test.expect_blocked('anon: cannot read roles catalogue',  'select * from public.roles');
select rls_test.expect_error('anon: cannot call get_my_access', 'select public.get_my_access()');
select rls_test.expect_error('anon: cannot log security events', $q$ select public.log_security_event('auth.sign_in') $q$);
select rls_test.expect_error('anon: cannot insert settings',
  format($q$ insert into public.company_settings (company_id, setting_key) values (%L, 'x.y') $q$, rls_test.id('company_a')));

reset role;

-- -----------------------------------------------------------------------------
-- Fresh signup (no company, inactive)
-- -----------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', rls_test.id('pending'), 'role', 'authenticated')::text, true);

select rls_test.ok('pending: get_my_access returns no roles or permissions',
  (select (a -> 'permissions') = '[]'::jsonb and (a -> 'roles') = '[]'::jsonb and (a -> 'company') = 'null'::jsonb
          and (a -> 'profile' ->> 'is_active')::boolean = false
   from (select public.get_my_access() a) s));
select rls_test.expect_rows('pending: can read only own profile', 'select * from public.profiles', 1);
select rls_test.expect_blocked('pending: cannot read companies', 'select * from public.companies');
select rls_test.expect_blocked('pending: cannot read roles catalogue', 'select * from public.roles');
select rls_test.expect_blocked('pending: cannot activate own profile',
  format($q$ update public.profiles set is_active = true where id = %L $q$, rls_test.id('pending')));
select rls_test.expect_error('pending: cannot set own company',
  format($q$ update public.profiles set company_id = %L where id = %L $q$, rls_test.id('company_a'), rls_test.id('pending')));
select rls_test.expect_error('pending: cannot grant itself a role',
  format($q$ insert into public.user_roles (user_id, company_id, role_id, assigned_by) values (%L, %L, %L, %L) $q$,
         rls_test.id('pending'), rls_test.id('company_a'), rls_test.id('role_super_admin'), rls_test.id('pending')));

reset role;

select rls_test.ok('pending: profile is still inactive, company-less and role-less after attempts',
  (select not is_active and company_id is null from public.profiles where id = rls_test.id('pending'))
  and not exists (select 1 from public.user_roles where user_id = rls_test.id('pending')));

-- -----------------------------------------------------------------------------
-- Auth user without a profile
-- -----------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', rls_test.id('noprofile'), 'role', 'authenticated')::text, true);

select rls_test.ok('no profile: get_my_access returns profile=null and no permissions',
  (select (a -> 'profile') = 'null'::jsonb and (a -> 'permissions') = '[]'::jsonb from (select public.get_my_access() a) s));
select rls_test.expect_blocked('no profile: cannot read companies', 'select * from public.companies');
select rls_test.expect_blocked('no profile: cannot read user_roles', 'select * from public.user_roles');

reset role;

-- -----------------------------------------------------------------------------
-- Deactivated user (still holds the ADMIN role)
-- -----------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', rls_test.id('inactive'), 'role', 'authenticated')::text, true);

select rls_test.ok('inactive: get_my_access returns no permissions',
  (select (a -> 'permissions') = '[]'::jsonb from (select public.get_my_access() a) s));
select rls_test.expect_blocked('inactive: cannot read company', 'select * from public.companies');
select rls_test.expect_blocked('inactive: cannot read settings', 'select * from public.company_settings');
select rls_test.expect_blocked('inactive: cannot read audit logs', 'select * from public.audit_logs');
select rls_test.expect_rows('inactive: sees no other profiles', 'select * from public.profiles where id <> auth.uid()', 0);
select rls_test.expect_blocked('inactive: cannot update company',
  $q$ update public.companies set display_name = 'Hacked' $q$);
select rls_test.expect_blocked('inactive: cannot change other users',
  format($q$ update public.profiles set is_active = false where id = %L $q$, rls_test.id('viewer')));

reset role;

-- -----------------------------------------------------------------------------
-- Administrator, company A
-- -----------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', rls_test.id('admin'), 'role', 'authenticated')::text, true);

select rls_test.expect_rows('admin: reads own company only', 'select * from public.companies', 1);
select rls_test.expect_rows('admin: reads company A profiles', 'select * from public.profiles', 6);
select rls_test.expect_error('admin: cannot grant itself a role',
  format($q$ insert into public.user_roles (user_id, company_id, role_id, assigned_by) values (%L, %L, %L, %L) $q$,
         rls_test.id('admin'), rls_test.id('company_a'), rls_test.id('role_accounts_manager'), rls_test.id('admin')));
select rls_test.expect_error('admin: cannot change own company membership',
  format($q$ update public.profiles set company_id = %L where id = %L $q$, rls_test.id('company_b'), rls_test.id('admin')));
select rls_test.expect_error('admin: cannot change own activation status',
  format($q$ update public.profiles set is_active = false where id = %L $q$, rls_test.id('admin')));
select rls_test.expect_error('admin: cannot UPDATE role assignments (revoke + grant only)',
  format($q$ update public.user_roles set role_id = %L where user_id = %L $q$, rls_test.id('role_super_admin'), rls_test.id('inv')));
select rls_test.expect_error('admin: cannot assign SUPER_ADMIN',
  format($q$ insert into public.user_roles (user_id, company_id, role_id, assigned_by) values (%L, %L, %L, %L) $q$,
         rls_test.id('inv'), rls_test.id('company_a'), rls_test.id('role_super_admin'), rls_test.id('admin')));
select rls_test.expect_blocked('admin: cannot revoke a Super Admin''s role',
  format($q$ delete from public.user_roles where user_id = %L $q$, rls_test.id('sa')));
select rls_test.expect_error('admin: cannot deactivate a Super Admin',
  format($q$ update public.profiles set is_active = false where id = %L $q$, rls_test.id('sa')));
select rls_test.expect_error('admin: cannot forge assigned_by',
  format($q$ insert into public.user_roles (user_id, company_id, role_id, assigned_by) values (%L, %L, %L, %L) $q$,
         rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_sales_manager'), rls_test.id('sa')));
select rls_test.expect_affected('admin: can grant a non-privileged role in own company',
  format($q$ insert into public.user_roles (user_id, company_id, role_id, assigned_by) values (%L, %L, %L, %L) $q$,
         rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_sales_manager'), rls_test.id('admin')), 1);
select rls_test.expect_affected('admin: can revoke that role',
  format($q$ delete from public.user_roles where user_id = %L and role_id = %L $q$,
         rls_test.id('viewer'), rls_test.id('role_sales_manager')), 1);
select rls_test.expect_error('admin: cannot assign a role in another company',
  format($q$ insert into public.user_roles (user_id, company_id, role_id, assigned_by) values (%L, %L, %L, %L) $q$,
         rls_test.id('b_admin'), rls_test.id('company_b'), rls_test.id('role_sales_manager'), rls_test.id('admin')));
select rls_test.expect_affected('admin: can deactivate a user in own company',
  format($q$ update public.profiles set is_active = false where id = %L $q$, rls_test.id('viewer')), 1);
select rls_test.expect_affected('admin: can reactivate that user',
  format($q$ update public.profiles set is_active = true where id = %L $q$, rls_test.id('viewer')), 1);
select rls_test.expect_affected('admin: can create a company setting',
  format($q$ insert into public.company_settings (company_id, setting_key, setting_value) values (%L, 'invoice.prefix', '"INV/"') $q$,
         rls_test.id('company_a')), 1);
select rls_test.expect_affected('admin: can update company profile fields',
  $q$ update public.companies set state = 'Test State' $q$, 1);
select rls_test.expect_error('admin: cannot change company code',
  $q$ update public.companies set company_code = 'HACK' $q$);
select rls_test.expect_rows('admin: cannot read company B settings',
  format('select * from public.company_settings where company_id = %L', rls_test.id('company_b')), 0);
select rls_test.expect_rows('admin: audit log recorded the role grant',
  $q$ select * from public.audit_logs where action = 'user_role.granted' and actor_user_id = auth.uid() $q$, 1);
select rls_test.expect_rows('admin: audit log recorded the settings change',
  $q$ select * from public.audit_logs where action = 'settings.created' and actor_user_id = auth.uid() $q$, 1);
select rls_test.expect_error('admin: cannot insert audit logs',
  format($q$ insert into public.audit_logs (company_id, action, resource_type) values (%L, 'fake.event', 'x') $q$, rls_test.id('company_a')));
select rls_test.expect_error('admin: cannot update audit logs', $q$ update public.audit_logs set action = 'tampered.event' $q$);
select rls_test.expect_error('admin: cannot delete audit logs', $q$ delete from public.audit_logs $q$);
select rls_test.expect_error('admin: cannot modify the permission catalogue',
  $q$ insert into public.permissions (resource, action) values ('users', 'own') $q$);
select rls_test.expect_error('admin: cannot modify role permissions',
  format($q$ insert into public.role_permissions (role_id, permission_id) select %L, id from public.permissions $q$, rls_test.id('role_admin')));
select rls_test.expect_error('log_security_event rejects unknown event types',
  $q$ select public.log_security_event('user.role_granted') $q$);
select public.log_security_event('auth.sign_in', '{"path":"/","access_token":"secret-value"}'::jsonb);
select rls_test.ok('log_security_event drops non-allow-listed metadata',
  (select metadata = '{"path":"/"}'::jsonb from public.audit_logs
   where action = 'auth.sign_in' and actor_user_id = auth.uid() order by event_timestamp desc limit 1));

reset role;

-- -----------------------------------------------------------------------------
-- Super Admin, company A
-- -----------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', rls_test.id('sa'), 'role', 'authenticated')::text, true);

select rls_test.expect_affected('super admin: can grant SUPER_ADMIN to another member',
  format($q$ insert into public.user_roles (user_id, company_id, role_id, assigned_by) values (%L, %L, %L, %L) $q$,
         rls_test.id('admin'), rls_test.id('company_a'), rls_test.id('role_super_admin'), rls_test.id('sa')), 1);
select rls_test.expect_affected('super admin: can revoke SUPER_ADMIN from another member',
  format($q$ delete from public.user_roles where user_id = %L and role_id = %L $q$,
         rls_test.id('admin'), rls_test.id('role_super_admin')), 1);
select rls_test.expect_blocked('super admin: cannot remove own Super Admin role',
  format($q$ delete from public.user_roles where user_id = %L $q$, rls_test.id('sa')));

reset role;

-- -----------------------------------------------------------------------------
-- Cross-company isolation: administrator of company B
-- -----------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', rls_test.id('b_admin'), 'role', 'authenticated')::text, true);

select rls_test.expect_rows('company B admin: sees only company B',
  'select * from public.companies', 1);
select rls_test.expect_rows('company B admin: cannot read company A',
  format('select * from public.companies where id = %L', rls_test.id('company_a')), 0);
select rls_test.expect_rows('company B admin: cannot read company A profiles',
  format('select * from public.profiles where company_id = %L', rls_test.id('company_a')), 0);
select rls_test.expect_rows('company B admin: cannot read company A role assignments',
  format('select * from public.user_roles where company_id = %L', rls_test.id('company_a')), 0);
select rls_test.expect_rows('company B admin: cannot read company A settings',
  format('select * from public.company_settings where company_id = %L', rls_test.id('company_a')), 0);
select rls_test.expect_rows('company B admin: cannot read company A audit logs',
  format('select * from public.audit_logs where company_id = %L', rls_test.id('company_a')), 0);
select rls_test.expect_blocked('company B admin: cannot update company A',
  format($q$ update public.companies set display_name = 'Hacked' where id = %L $q$, rls_test.id('company_a')));
select rls_test.expect_blocked('company B admin: cannot deactivate company A users',
  format($q$ update public.profiles set is_active = false where id = %L $q$, rls_test.id('inv')));
select rls_test.expect_error('company B admin: cannot write company A settings',
  format($q$ insert into public.company_settings (company_id, setting_key) values (%L, 'x.y') $q$, rls_test.id('company_a')));
select rls_test.expect_blocked('company B admin: cannot revoke company A roles',
  format($q$ delete from public.user_roles where company_id = %L $q$, rls_test.id('company_a')));

reset role;

-- -----------------------------------------------------------------------------
-- Management Viewer (read-only)
-- -----------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', rls_test.id('viewer'), 'role', 'authenticated')::text, true);

select rls_test.expect_rows('viewer: can read own company', 'select * from public.companies', 1);
select rls_test.expect_blocked('viewer: cannot update company',
  $q$ update public.companies set display_name = 'Changed' $q$);
select rls_test.expect_blocked('viewer: cannot read settings', 'select * from public.company_settings');
select rls_test.expect_error('viewer: cannot create settings',
  format($q$ insert into public.company_settings (company_id, setting_key) values (%L, 'x.y') $q$, rls_test.id('company_a')));
select rls_test.expect_error('viewer: cannot assign roles',
  format($q$ insert into public.user_roles (user_id, company_id, role_id, assigned_by) values (%L, %L, %L, %L) $q$,
         rls_test.id('inv'), rls_test.id('company_a'), rls_test.id('role_sales_manager'), rls_test.id('viewer')));
select rls_test.expect_blocked('viewer: cannot deactivate users',
  format($q$ update public.profiles set is_active = false where id = %L $q$, rls_test.id('inv')));
select rls_test.expect_blocked('viewer: cannot read audit logs', 'select * from public.audit_logs');
select rls_test.ok('viewer: get_my_access has no write permissions',
  (select not exists (select 1 from jsonb_array_elements_text(a -> 'permissions') p where p not like '%.read')
   from (select public.get_my_access() a) s));

reset role;

-- -----------------------------------------------------------------------------
-- Inventory Manager
-- -----------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', rls_test.id('inv'), 'role', 'authenticated')::text, true);

select rls_test.expect_error('inventory manager: cannot assign roles',
  format($q$ insert into public.user_roles (user_id, company_id, role_id, assigned_by) values (%L, %L, %L, %L) $q$,
         rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_admin'), rls_test.id('inv')));
select rls_test.expect_rows('inventory manager: sees only own role assignments',
  'select * from public.user_roles', 1);
select rls_test.expect_blocked('inventory manager: cannot update settings',
  $q$ update public.company_settings set setting_value = '"x"' $q$);
select rls_test.expect_blocked('inventory manager: cannot update company',
  $q$ update public.companies set display_name = 'Changed' $q$);
select rls_test.expect_affected('inventory manager: can update own display name',
  format($q$ update public.profiles set full_name = 'Inventory Person' where id = %L $q$, rls_test.id('inv')), 1);
select rls_test.expect_blocked('inventory manager: cannot rename other users',
  format($q$ update public.profiles set full_name = 'Renamed' where id = %L $q$, rls_test.id('viewer')));

reset role;

-- =============================================================================
-- PHASE 3: PRODUCT MASTER
-- =============================================================================

select rls_test.ok('products table has no stock/quantity columns (inventory is Phase 4)',
  not exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'products'
                and (column_name ~ '(stock|qty|quantity|on_hand|available|reserved|balance)')));

select rls_test.ok('product permissions are granular and seeded',
  (select count(*) from public.permissions where code in
     ('products.create','products.update','products.archive','products.import','products.export','product_categories.manage')) = 6);

select rls_test.ok('Management Viewer still holds only read permissions after Phase 3',
  not exists (select 1 from public.role_permissions rp
              join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id
              where r.code = 'MANAGEMENT_VIEWER' and p.action <> 'read'));

-- ---------------------------------------------------------------------------
-- Inventory Manager (products.create/update/archive/import, categories.manage)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', rls_test.id('inv'), 'role', 'authenticated')::text, true);

select rls_test.expect_affected('products: create with optional commercial fields blank',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, category_id)
             values (%L, 'WC-100', 'Test Closet', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', %L) $q$,
         rls_test.id('company_a'), rls_test.id('cat_a')), 1);
select rls_test.ok('products: created_by/updated_by set by the database, status defaults to ACTIVE',
  (select created_by = auth.uid() and updated_by = auth.uid() and status = 'ACTIVE'
          and gst_rate is null and selling_price is null and standard_cost is null
   from public.products where sku = 'WC-100'));
select rls_test.expect_error('products: duplicate SKU in same company rejected (case-insensitive)',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit)
             values (%L, 'wc-100', 'Another', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS') $q$, rls_test.id('company_a')));
select rls_test.expect_affected('products: HYBRID with empty barcode accepted',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, barcode, category_id)
             values (%L, 'BASIN-1', 'Test Basin', 'FINISHED_GOOD', 'HYBRID', 'pcs', '  ', %L) $q$,
         rls_test.id('company_a'), rls_test.id('cat_a')), 1);
select rls_test.ok('products: empty barcode stored as NULL, unit normalised',
  (select barcode is null and base_unit = 'PCS' from public.products where sku = 'BASIN-1'));
select rls_test.expect_affected('products: second product with blank barcode accepted (NULLs not duplicates)',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, barcode, gst_rate, selling_price, standard_cost, minimum_selling_price, hsn_code)
             values (%L, 'TAP-1', 'Test Tap', 'FINISHED_GOOD', 'OUTSOURCED', 'PCS', '', 18, 1500, 900, 1200, '84818020') $q$,
         rls_test.id('company_a')), 1);
select rls_test.expect_affected('products: barcode accepted',
  $q$ update public.products set barcode = '8901234567890' where sku = 'TAP-1' $q$, 1);
select rls_test.expect_error('products: duplicate barcode in same company rejected',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, barcode)
             values (%L, 'TAP-2', 'Dup barcode', 'FINISHED_GOOD', 'OUTSOURCED', 'PCS', '8901234567890') $q$, rls_test.id('company_a')));
select rls_test.expect_error('products: invalid source type rejected',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit)
             values (%L, 'BAD-1', 'Bad', 'FINISHED_GOOD', 'INHOUSE', 'PCS') $q$, rls_test.id('company_a')));
select rls_test.expect_error('products: invalid product type rejected',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit)
             values (%L, 'BAD-2', 'Bad', 'TOILET', 'IN_HOUSE', 'PCS') $q$, rls_test.id('company_a')));
select rls_test.expect_error('products: negative price rejected',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, selling_price)
             values (%L, 'BAD-3', 'Bad', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', -1) $q$, rls_test.id('company_a')));
select rls_test.expect_error('products: negative standard cost rejected',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, standard_cost)
             values (%L, 'BAD-4', 'Bad', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', -0.01) $q$, rls_test.id('company_a')));
select rls_test.expect_error('products: minimum selling price above selling price rejected',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, selling_price, minimum_selling_price)
             values (%L, 'BAD-5', 'Bad', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 100, 150) $q$, rls_test.id('company_a')));
select rls_test.expect_error('products: invalid HSN rejected',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, hsn_code)
             values (%L, 'BAD-6', 'Bad', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', '12AB') $q$, rls_test.id('company_a')));
select rls_test.expect_error('products: GST rate above 100 rejected',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, gst_rate)
             values (%L, 'BAD-7', 'Bad', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 150) $q$, rls_test.id('company_a')));
-- SKUs are free format (20261120090000): spaces and symbols are accepted. The insert is undone at once
-- (so later product counts are unchanged); the check passes only if the insert itself succeeded.
do $$
begin
  begin
    insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit)
    values (rls_test.id('company_a'), 'WC 200 #A (White)', 'Free-format SKU', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS');
    raise exception 'sku-accepted';
  exception when others then
    perform rls_test.ok('products: SKU with spaces and symbols accepted (free format)', sqlerrm = 'sku-accepted', sqlerrm);
  end;
end $$;
select rls_test.expect_error('products: category from another company rejected',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, category_id)
             values (%L, 'BAD-8', 'Bad', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', %L) $q$, rls_test.id('company_a'), rls_test.id('cat_b')));
select rls_test.expect_error('products: inactive category rejected for new product',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, category_id)
             values (%L, 'BAD-9', 'Bad', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', %L) $q$, rls_test.id('company_a'), rls_test.id('cat_a_old')));
select rls_test.expect_error('products: clients cannot set created_by',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, created_by)
             values (%L, 'BAD-10', 'Bad', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', %L) $q$, rls_test.id('company_a'), rls_test.id('sa')));
select rls_test.expect_error('products: clients cannot set preferred_supplier_id directly (no column grant; same-company FK to suppliers)',
  format($q$ update public.products set preferred_supplier_id = %L where sku = 'TAP-1' $q$, rls_test.id('sa')));
select rls_test.expect_affected('products: edit details',
  $q$ update public.products set product_name = 'Test Closet (edited)', brand = 'Alton' where sku = 'WC-100' $q$, 1);
select rls_test.ok('products: updated_by tracks the editor',
  (select updated_by = auth.uid() and product_name = 'Test Closet (edited)' from public.products where sku = 'WC-100'));
select rls_test.expect_error('products: company_id cannot be changed',
  format($q$ update public.products set company_id = %L where sku = 'WC-100' $q$, rls_test.id('company_b')));
select rls_test.expect_error('products: created_by cannot be changed',
  format($q$ update public.products set created_by = %L where sku = 'WC-100' $q$, rls_test.id('sa')));
select rls_test.expect_error('products: cannot be deleted',
  $q$ delete from public.products where sku = 'WC-100' $q$);
select rls_test.expect_error('products: cannot archive an ACTIVE product',
  $q$ update public.products set archived_at = now() where sku = 'WC-100' $q$);
select rls_test.expect_affected('products: deactivate',
  $q$ update public.products set status = 'INACTIVE' where sku = 'WC-100' $q$, 1);
select rls_test.expect_affected('products: archive inactive product',
  $q$ update public.products set archived_at = '2000-01-01' where sku = 'WC-100' $q$, 1);
select rls_test.ok('products: archive timestamp/actor set by the database',
  (select archived_at > now() - interval '1 minute' and archived_by = auth.uid() from public.products where sku = 'WC-100'));
select rls_test.expect_affected('products: SKU correction allowed while no transactions exist',
  $q$ update public.products set sku = 'TAP-001' where sku = 'TAP-1' $q$, 1);
select rls_test.expect_error('products: image path outside the product folder rejected',
  $q$ update public.products set product_image_path = 'other/folder/x.png' where sku = 'BASIN-1' $q$);
select rls_test.expect_affected('products: image path in own product folder accepted',
  $q$ update public.products set product_image_path = company_id::text || '/' || id::text || '/photo.png' where sku = 'BASIN-1' $q$, 1);

-- Categories
select rls_test.expect_affected('categories: create',
  format($q$ insert into public.product_categories (company_id, code, name) values (%L, 'NEW_CAT', 'New Category') $q$, rls_test.id('company_a')), 1);
select rls_test.expect_error('categories: duplicate code in same company rejected',
  format($q$ insert into public.product_categories (company_id, code, name) values (%L, 'NEW_CAT', 'Different name') $q$, rls_test.id('company_a')));
select rls_test.expect_error('categories: duplicate name (case-insensitive) rejected',
  format($q$ insert into public.product_categories (company_id, code, name) values (%L, 'NEW_CAT_2', 'NEW CATEGORY') $q$, rls_test.id('company_a')));
select rls_test.expect_error('categories: code is immutable',
  format($q$ update public.product_categories set code = 'RENAMED' where id = %L $q$, rls_test.id('cat_a')));
select rls_test.expect_error('categories: cannot be deleted',
  format($q$ delete from public.product_categories where id = %L $q$, rls_test.id('cat_a')));
select rls_test.expect_error('categories: cannot deactivate while active products use it',
  format($q$ update public.product_categories set is_active = false where id = %L $q$, rls_test.id('cat_a')));
select rls_test.expect_affected('categories: deactivate the remaining active product',
  $q$ update public.products set status = 'INACTIVE' where sku = 'BASIN-1' $q$, 1);
select rls_test.expect_affected('categories: deactivation allowed once no active products use it',
  format($q$ update public.product_categories set is_active = false where id = %L $q$, rls_test.id('cat_a')), 1);
select rls_test.ok('categories: products keep their historical category reference',
  (select category_id = rls_test.id('cat_a') from public.products where sku = 'WC-100'));
select rls_test.expect_rows('categories: product counts per category',
  format($q$ select * from public.product_category_counts() where category_id = %L and total_products = 2 and active_products = 0 $q$, rls_test.id('cat_a')), 1);

-- Read helpers and storage
select rls_test.ok('product_kpis counts real rows',
  (select (k ->> 'active')::int = 1 and (k ->> 'outsourced')::int = 1 and (k ->> 'archived')::int = 1
          and (k ->> 'inactive')::int = 1 and (k ->> 'total')::int = 3
   from (select public.product_kpis() k) s));
select rls_test.expect_rows('check_product_identifiers matches SKU case-insensitively',
  $q$ select * from public.check_product_identifiers(array['wc-100', 'NOPE-1'], array['8901234567890']) $q$, 2);
select rls_test.expect_affected('storage: upload image into own product folder',
  $q$ insert into storage.objects (bucket_id, name) select 'product-images', company_id::text || '/' || id::text || '/photo.png' from public.products where sku = 'BASIN-1' $q$, 1);
select rls_test.expect_error('storage: upload into another company''s folder rejected',
  format($q$ insert into storage.objects (bucket_id, name) values ('product-images', %L || '/' || gen_random_uuid() || '/x.png') $q$, rls_test.id('company_b')));
select rls_test.expect_error('storage: upload to a folder that is not a product rejected',
  format($q$ insert into storage.objects (bucket_id, name) values ('product-images', %L || '/anything/x.png') $q$, rls_test.id('company_a')));
select public.log_product_import('test.xlsx', 10, 7, 2, 1);
select rls_test.expect_blocked('inventory manager: cannot read the audit log it generated',
  'select * from public.audit_logs');

reset role;

-- Audit checks as owner (the Inventory Manager has no audit_logs.read).
select rls_test.ok('import summary is audited',
  exists (select 1 from public.audit_logs where action = 'product.import_completed' and actor_user_id = rls_test.id('inv')));
select rls_test.ok('product creation, edits, status, archive and SKU change are audited',
  (select count(distinct action) = 6 from public.audit_logs
   where actor_user_id = rls_test.id('inv') and action in
     ('product.created', 'product.updated', 'product.deactivated', 'product.archived', 'product.sku_changed', 'product_category.deactivated')));

-- ---------------------------------------------------------------------------
-- Sales Manager (products.read + export only)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', rls_test.id('sales'), 'role', 'authenticated')::text, true);

select rls_test.expect_rows('sales: can read company A products', 'select * from public.products', 3);
select rls_test.expect_error('sales: cannot create products',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit)
             values (%L, 'S-1', 'Nope', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS') $q$, rls_test.id('company_a')));
select rls_test.expect_blocked('sales: cannot edit products',
  $q$ update public.products set product_name = 'Changed' where sku = 'TAP-001' $q$);
select rls_test.expect_blocked('sales: cannot change product status',
  $q$ update public.products set status = 'INACTIVE' where sku = 'TAP-001' $q$);
select rls_test.expect_error('sales: cannot create categories',
  format($q$ insert into public.product_categories (company_id, code, name) values (%L, 'SALES_CAT', 'Sales cat') $q$, rls_test.id('company_a')));
select rls_test.expect_blocked('sales: cannot edit categories',
  format($q$ update public.product_categories set name = 'Changed' where id = %L $q$, rls_test.id('cat_a')));
select rls_test.expect_error('sales: cannot log product imports',
  $q$ select public.log_product_import('x.xlsx', 1, 1, 0, 0) $q$);
select rls_test.expect_error('sales: cannot upload product images',
  $q$ insert into storage.objects (bucket_id, name) select 'product-images', company_id::text || '/' || id::text || '/x.png' from public.products where sku = 'TAP-001' $q$);
select rls_test.expect_rows('sales: can view product images', $q$ select * from storage.objects where bucket_id = 'product-images' $q$, 1);

reset role;

-- ---------------------------------------------------------------------------
-- Management Viewer: read-only
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', rls_test.id('viewer'), 'role', 'authenticated')::text, true);

select rls_test.expect_rows('viewer: can read products', 'select * from public.products', 3);
select rls_test.expect_blocked('viewer: cannot edit products',
  $q$ update public.products set product_name = 'Changed' $q$);
select rls_test.ok('viewer: display-name lookup returns names only, for own company',
  (select count(*) = 1 from public.user_display_names(array[rls_test.id('inv'), rls_test.id('b_admin')])));

reset role;

-- An inactive user gets no names.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', rls_test.id('inactive'), 'role', 'authenticated')::text, true);
select rls_test.expect_rows('inactive: display-name lookup returns nothing',
  format('select * from public.user_display_names(array[%L]::uuid[])', rls_test.id('inv')), 0);
select rls_test.expect_rows('inactive: cannot read products', 'select * from public.products', 0);

reset role;

-- ---------------------------------------------------------------------------
-- Cross-company: administrator of company B
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', rls_test.id('b_admin'), 'role', 'authenticated')::text, true);

select rls_test.expect_rows('company B: cannot read company A products',
  format('select * from public.products where company_id = %L', rls_test.id('company_a')), 0);
select rls_test.expect_rows('company B: cannot read company A categories',
  format('select * from public.product_categories where company_id = %L', rls_test.id('company_a')), 0);
select rls_test.expect_error('company B: cannot create products in company A',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit)
             values (%L, 'X-1', 'Nope', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS') $q$, rls_test.id('company_a')));
select rls_test.expect_blocked('company B: cannot edit company A products',
  $q$ update public.products set product_name = 'Hacked' where sku = 'TAP-001' $q$);
select rls_test.expect_affected('company B: same SKU allowed in a different company',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, category_id)
             values (%L, 'WC-100', 'Company B closet', 'FINISHED_GOOD', 'OUTSOURCED', 'PCS', %L) $q$,
         rls_test.id('company_b'), rls_test.id('cat_b')), 1);
select rls_test.expect_rows('company B: identifier lookup sees only its own products',
  $q$ select * from public.check_product_identifiers(array['WC-100', 'TAP-001'], array['8901234567890']) $q$, 1);
select rls_test.ok('company B: KPIs count only company B products',
  (select (k ->> 'total')::int = 1 from (select public.product_kpis() k) s));
select rls_test.expect_rows('company B: display-name lookup cannot reveal company A users',
  format('select * from public.user_display_names(array[%L, %L]::uuid[])', rls_test.id('inv'), rls_test.id('sa')), 0);
select rls_test.expect_rows('company B: display-name lookup works for own company',
  format('select * from public.user_display_names(array[%L]::uuid[])', rls_test.id('b_admin')), 1);
select rls_test.expect_rows('company B: cannot see company A product images',
  $q$ select * from storage.objects where bucket_id = 'product-images' $q$, 0);
select rls_test.expect_error('company B: cannot create a category with a company A id',
  format($q$ insert into public.product_categories (company_id, code, name) values (%L, 'B_INTO_A', 'Nope') $q$, rls_test.id('company_a')));

reset role;

-- -----------------------------------------------------------------------------
-- Summary. Always raises so the transaction (and all test data) is rolled back.
-- -----------------------------------------------------------------------------
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
  raise exception 'RLS_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
