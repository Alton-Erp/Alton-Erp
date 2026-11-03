-- =============================================================================
-- USER INVITATIONS AND FUNCTIONAL ROLES (ALTON ERP V2)
-- migration 20261116090000_user_invitations.sql
--
-- The invite-user Edge Function is simulated step by step: prepare (caller JWT),
-- the Supabase Auth invitation (an auth.users row), finalize / fail (service_role).
-- Numbers = section 11 of the request.
-- Runs in one transaction and ALWAYS ends by raising
--   USER_INVITATIONS_RESULT passed=N failed=M
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
create function rls_test.prepare(p_email text, p_codes text[], p_key uuid default null, p_details jsonb default '{}'::jsonb) returns text language sql stable as $$
  select format('select public.user_invitation_prepare(%L, %L, %L::jsonb, %L::uuid[], %L)', p_email, 'Invitee ' || split_part(p_email, '@', 1), p_details,
    (select array_agg(rls_test.role_id(c)) from unnest(p_codes) c), coalesce(p_key, gen_random_uuid())) $$;
-- What Supabase Auth does on inviteUserByEmail: a new auth.users row (the profile trigger runs).
create function rls_test.auth_user(p_key text, p_email text, p_signed_in boolean default false, p_meta jsonb default '{}'::jsonb) returns uuid language plpgsql security definer as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at) values (v, p_email, p_meta, case when p_signed_in then now() end);
  insert into rls_test.ids values (p_key, v) on conflict (key) do update set id = excluded.id;
  return v;
end $$;
create function rls_test.inv(p_id uuid) returns public.user_invitations language sql stable security definer as $$ select * from public.user_invitations where id = p_id $$;
create function rls_test.profile(p_id uuid) returns public.profiles language sql stable security definer as $$ select * from public.profiles where id = p_id $$;
create function rls_test.roles_of(p_user uuid) returns text[] language sql stable security definer as $$
  select coalesce(array_agg(r.code order by r.code), '{}') from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = p_user $$;
create function rls_test.audits(p_action text) returns bigint language sql stable security definer as $$ select count(*) from public.audit_logs where action = p_action $$;
create function rls_test.cat(p_cat jsonb, p_code text) returns jsonb language sql immutable as $$ select r from jsonb_array_elements(p_cat -> 'roles') r where r ->> 'code' = p_code $$;
grant execute on all functions in schema rls_test to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5d100-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5d100-0000-4000-8000-0000000000b1'),
  ('sa', 'e7e5d100-0000-4000-8000-000000000001'), ('adm', 'e7e5d100-0000-4000-8000-000000000002'), ('viewer', 'e7e5d100-0000-4000-8000-000000000003'),
  ('member', 'e7e5d100-0000-4000-8000-000000000004'), ('b_sa', 'e7e5d100-0000-4000-8000-000000000005');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;
insert into public.companies (id, legal_name, display_name, company_code, email) values
  (rls_test.id('company_a'), 'Invite Test A Pvt Ltd', 'Invite A', 'INVA', 'support@invite-a.example.invalid'),
  (rls_test.id('company_b'), 'Invite Test B Pvt Ltd', 'Invite B', 'INVB', null);
insert into auth.users (id, email, last_sign_in_at) select id, key || '@inv.example.invalid', now() from rls_test.ids where key in ('sa', 'adm', 'viewer', 'member', 'b_sa');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true, full_name = 'Asha Admin' where id = rls_test.id('sa');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id in (rls_test.id('adm'), rls_test.id('viewer'), rls_test.id('member'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_sa');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('sa'), rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('adm'), rls_test.id('company_a'), rls_test.id('role_admin')),
  (rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_management_viewer')),
  (rls_test.id('member'), rls_test.id('company_a'), rls_test.id('role_sales_manager')),
  (rls_test.id('b_sa'), rls_test.id('company_b'), rls_test.id('role_super_admin'));

-- ---------------------------------------------------------------------------
-- Roles catalogue
-- ---------------------------------------------------------------------------
select rls_test.ok('roles: 8 existing roles kept, 13 functional roles added (21 in total), none duplicated',
  (select count(*) from public.roles) = 21 and (select count(distinct name) from public.roles) = 21);
select rls_test.ok('roles: new executive / viewer roles hold no approval, cancellation, reversal or administrative permission',
  not exists (select 1 from public.roles r join public.role_permissions rp on rp.role_id = r.id join public.permissions p on p.id = rp.permission_id
              where r.code in ('ACCOUNTS_EXECUTIVE', 'SALES_EXECUTIVE', 'PURCHASE_EXECUTIVE', 'STORE_EXECUTIVE', 'PRODUCTION_EXECUTIVE', 'DISPATCH_EXECUTIVE', 'REPORTS_VIEWER', 'HR_MANAGER')
                and (p.action in ('approve', 'cancel', 'reverse', 'approve_adjustment') or p.code in ('users.manage', 'settings.manage', 'system.reset_data', 'approvals.manage'))));
select rls_test.ok('roles: Reports Viewer and Management Viewer are read-only (no create, update, manage, issue or posting permission)',
  not exists (select 1 from public.roles r join public.role_permissions rp on rp.role_id = r.id join public.permissions p on p.id = rp.permission_id
              where r.code in ('REPORTS_VIEWER', 'MANAGEMENT_VIEWER') and p.action not in ('read')));
select rls_test.ok('roles: existing role grants unchanged (Inventory Manager 64 permissions, Super Admin all 129)',
  (select count(*) from public.role_permissions where role_id = rls_test.id('role_inventory_manager')) = 64
  and (select count(*) from public.role_permissions where role_id = rls_test.id('role_super_admin')) = (select count(*) from public.permissions));

set local role authenticated;
select rls_test.claims('sa');
select rls_test.expect_call_ok('catalogue for a Super Admin', 'cat_sa', 'select public.invite_role_catalog()');
select rls_test.claims('adm');
select rls_test.expect_call_ok('catalogue for an Administrator', 'cat_adm', 'select public.invite_role_catalog()');
select rls_test.claims('viewer');
select rls_test.expect_call_error('3. catalogue refused without users.manage', 'select public.invite_role_catalog()', 'not allowed');
reset role;
select rls_test.ok('1. catalogue: 21 roles in 8 categories with description, modules, permissions and admin flag; all assignable by a Super Admin',
  jsonb_array_length(rls_test.get('cat_sa') -> 'roles') = 21
  and (select count(distinct r ->> 'category') from jsonb_array_elements(rls_test.get('cat_sa') -> 'roles') r) = 8
  and (rls_test.cat(rls_test.get('cat_sa'), 'SUPER_ADMIN') ->> 'is_admin')::boolean and (rls_test.cat(rls_test.get('cat_sa'), 'ADMIN') ->> 'is_admin')::boolean
  and not (rls_test.cat(rls_test.get('cat_sa'), 'INVENTORY_MANAGER') ->> 'is_admin')::boolean
  and rls_test.cat(rls_test.get('cat_sa'), 'INVENTORY_MANAGER') -> 'modules' ? 'inventory'
  and jsonb_array_length(rls_test.cat(rls_test.get('cat_sa'), 'HR_MANAGER') -> 'permissions') = 3
  and not exists (select 1 from jsonb_array_elements(rls_test.get('cat_sa') -> 'roles') r where not (r ->> 'assignable')::boolean), rls_test.get('cat_sa') ->> 'is_super_admin');
select rls_test.ok('4. catalogue for an Administrator: Super Admin and Administrator are not assignable, other roles are',
  not (rls_test.cat(rls_test.get('cat_adm'), 'SUPER_ADMIN') ->> 'assignable')::boolean and not (rls_test.cat(rls_test.get('cat_adm'), 'ADMIN') ->> 'assignable')::boolean
  and (rls_test.cat(rls_test.get('cat_adm'), 'SALES_EXECUTIVE') ->> 'assignable')::boolean and (rls_test.cat(rls_test.get('cat_adm'), 'MANAGEMENT_VIEWER') ->> 'assignable')::boolean);

-- ---------------------------------------------------------------------------
-- 1. Super Admin invites; 8. e-mail sent (finalize); 9/10. activation
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('sa');
select rls_test.expect_call_ok('1. Super Admin invites new@ as Super Admin + Inventory Manager', 'p1',
  rls_test.prepare('New@Inv.Example.Invalid', array['SUPER_ADMIN', 'INVENTORY_MANAGER'], 'e7e5d100-0000-4000-8000-0000000000f1',
    jsonb_build_object('employee_id', 'EMP-101', 'department', 'Stores', 'designation', 'Store head', 'reporting_manager_id', rls_test.id('sa'))));
reset role;
select rls_test.ok('1. invitation recorded: PENDING, e-mail SENDING, e-mail normalised, employee details, expiry, data for the e-mail',
  (rls_test.inv(rls_test.gid('p1', 'invitation_id'))).status = 'PENDING' and (rls_test.inv(rls_test.gid('p1', 'invitation_id'))).email = 'new@inv.example.invalid'
  and (rls_test.inv(rls_test.gid('p1', 'invitation_id'))).employee_id = 'EMP-101' and (rls_test.inv(rls_test.gid('p1', 'invitation_id'))).department = 'Stores'
  and (rls_test.inv(rls_test.gid('p1', 'invitation_id'))).expires_at > now() + interval '23 hours'
  and rls_test.get('p1') ->> 'company_name' = 'Invite A' and rls_test.get('p1') ->> 'support_email' = 'support@invite-a.example.invalid'
  and rls_test.get('p1') -> 'roles' ? 'Super Admin' and (rls_test.get('p1') ->> 'needs_send')::boolean and rls_test.get('p1') -> 'replace_auth_user_id' = 'null'::jsonb,
  rls_test.get('p1')::text);
-- Supabase Auth creates the user (metadata tries to claim company B: never trusted).
select rls_test.auth_user('new', 'new@inv.example.invalid', false, jsonb_build_object('company_id', rls_test.id('company_b'), 'full_name', 'New Person'));
set local role service_role;
select rls_test.expect_call_ok('8. invitation e-mail sent: finalize (service role)', 'f1', format('select public.user_invitation_finalize(%L, %L)', rls_test.gid('p1', 'invitation_id'), rls_test.id('new')));
reset role;
select rls_test.ok('8. finalize: profile linked to company A (not the company in the metadata), inactive until accepted, roles assigned, e-mail SENT, audited',
  (rls_test.profile(rls_test.id('new'))).company_id = rls_test.id('company_a') and not (rls_test.profile(rls_test.id('new'))).is_active
  and rls_test.roles_of(rls_test.id('new')) = array['INVENTORY_MANAGER', 'SUPER_ADMIN']
  and (rls_test.inv(rls_test.gid('p1', 'invitation_id'))).email_status = 'SENT' and (rls_test.inv(rls_test.gid('p1', 'invitation_id'))).send_count = 1
  and rls_test.audits('user.invited') = 1, rls_test.get('f1')::text);

-- 6. Duplicates: same request again / another request for the same e-mail.
set local role authenticated;
select rls_test.claims('sa');
select rls_test.expect_call_ok('6. the same invitation request again (retry)', 'p1b',
  rls_test.prepare('new@inv.example.invalid', array['SUPER_ADMIN', 'INVENTORY_MANAGER'], 'e7e5d100-0000-4000-8000-0000000000f1'));
select rls_test.expect_call_error('6. a second invitation for the same e-mail is refused (resend instead)', rls_test.prepare('new@inv.example.invalid', array['SALES_EXECUTIVE']), 'Resend it');
reset role;
select rls_test.ok('6. retry returns the stored invitation, nothing to send again, no second invitation',
  (rls_test.get('p1b') ->> 'duplicate')::boolean and not (rls_test.get('p1b') ->> 'needs_send')::boolean
  and rls_test.gid('p1b', 'invitation_id') = rls_test.gid('p1', 'invitation_id')
  and (select count(*) from public.user_invitations where email = 'new@inv.example.invalid') = 1, rls_test.get('p1b')::text);

-- 9/10. The invitee opens the link, sets a password and activates.
set local role authenticated;
select rls_test.claims('new');
select rls_test.expect_call_ok('9. invitee sees the invitation (company, roles, expiry) before activation', 'my', 'select public.my_invitation()');
select rls_test.set('access_before', rls_test.call('select public.get_my_access()'));
select rls_test.expect_call_ok('9. invitee activates the account', 'acc', 'select public.user_invitation_accept()');
select rls_test.set('access_after', rls_test.call('select public.get_my_access()'));
select rls_test.expect_call_ok('9. activating twice is harmless', 'acc2', 'select public.user_invitation_accept()');
reset role;
select rls_test.ok('9. onboarding data: company A, roles, PENDING, support e-mail',
  rls_test.get('my') ->> 'company_name' = 'Invite A' and rls_test.get('my') -> 'roles' ? 'Inventory Manager' and rls_test.get('my') ->> 'status' = 'PENDING'
  and rls_test.get('my') ->> 'support_email' = 'support@invite-a.example.invalid', rls_test.get('my')::text);
select rls_test.ok('10. before activation the account has no access; after it the assigned roles and permissions load',
  coalesce(jsonb_array_length(rls_test.get('access_before') -> 'roles'), 0) = 0
  and rls_test.get('access_after') -> 'roles' ? 'SUPER_ADMIN' and rls_test.get('access_after') -> 'roles' ? 'INVENTORY_MANAGER'
  and rls_test.get('access_after') -> 'permissions' ? 'inventory.read', rls_test.get('access_after')::text);
select rls_test.ok('9. accepted: profile active, invitation ACCEPTED with time; second call reports already accepted',
  (rls_test.profile(rls_test.id('new'))).is_active and (rls_test.inv(rls_test.gid('p1', 'invitation_id'))).status = 'ACCEPTED'
  and (rls_test.inv(rls_test.gid('p1', 'invitation_id'))).accepted_at is not null and (rls_test.get('acc2') ->> 'already_accepted')::boolean, rls_test.get('acc')::text);
select rls_test.ok('15. activation audited (invitation accepted)', rls_test.audits('user.invitation_accepted') = 1, rls_test.audits('user.invitation_accepted')::text);
select rls_test.ok('9. inviter notified of the activation',
  exists (select 1 from public.notifications where recipient_user_id = rls_test.id('sa') and notification_type = 'USER_ACTIVATED'),
  (select string_agg(notification_type || ':' || recipient_user_id, ', ') from public.notifications));

-- ---------------------------------------------------------------------------
-- 2/4. Administrator; 3. unauthorised; 5. cross-company; 7. existing users
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('adm');
select rls_test.expect_call_ok('2. Administrator invites a Sales Executive', 'p2', rls_test.prepare('sales@inv.example.invalid', array['SALES_EXECUTIVE']));
select rls_test.expect_call_error('4. Administrator cannot assign Super Admin', rls_test.prepare('boss@inv.example.invalid', array['SUPER_ADMIN']), 'Only a Super Admin');
select rls_test.expect_call_error('4. Administrator cannot assign the Administrator role either (administrative)', rls_test.prepare('boss@inv.example.invalid', array['ADMIN', 'SALES_EXECUTIVE']), 'Administrator');
select rls_test.claims('viewer');
select rls_test.expect_call_error('3. a user without users.manage cannot invite', rls_test.prepare('x@inv.example.invalid', array['REPORTS_VIEWER']), 'not allowed');
select rls_test.claims('b_sa');
select rls_test.expect_call_error('5. company B cannot invite a user of company A', rls_test.prepare('member@inv.example.invalid', array['REPORTS_VIEWER']), 'another company');
select rls_test.expect_call_ok('5. company B invitation list', 'b_list', 'select public.user_invitations_list()');
select rls_test.set('b_rows', rls_test.call('select to_jsonb(count(*)) from public.user_invitations'));
select rls_test.claims('sa');
select rls_test.expect_call_error('5. company A cannot invite a user of company B', rls_test.prepare('b_sa@inv.example.invalid', array['REPORTS_VIEWER']), 'another company');
select rls_test.expect_call_error('5. a role id that does not exist is refused',
  format('select public.user_invitation_prepare(%L, %L, ''{}''::jsonb, %L::uuid[], %L)', 'ghost@inv.example.invalid', 'Ghost', array[gen_random_uuid()], gen_random_uuid()), 'does not exist');
select rls_test.expect_call_error('7. an existing user of the company is not invited again', rls_test.prepare('member@inv.example.invalid', array['REPORTS_VIEWER']), 'already a user');
select rls_test.expect_call_error('validation: e-mail format', rls_test.prepare('not-an-email', array['REPORTS_VIEWER']), 'valid work e-mail');
select rls_test.expect_call_error('validation: at least one role', format('select public.user_invitation_prepare(%L, %L, ''{}''::jsonb, ''{}''::uuid[], %L)', 'r@inv.example.invalid', 'R', gen_random_uuid()), 'at least one role');
select rls_test.expect_call_error('validation: reporting manager must be a user of the company',
  rls_test.prepare('m2@inv.example.invalid', array['REPORTS_VIEWER'], null, jsonb_build_object('reporting_manager_id', rls_test.id('b_sa'))), 'reporting manager');
reset role;
select rls_test.ok('5. company B sees none of company A''s invitations', jsonb_array_length(rls_test.get('b_list')) = 0 and rls_test.get('b_rows') = '0'::jsonb,
  rls_test.get('b_list')::text);

-- 7. Existing Auth accounts without a company: one never signed in (replaced), one that has (attached).
select rls_test.auth_user('orphan', 'orphan@inv.example.invalid', false);
select rls_test.auth_user('selfsign', 'selfsign@inv.example.invalid', true);
set local role authenticated;
select rls_test.claims('sa');
select rls_test.expect_call_ok('7. invite an e-mail whose earlier Auth user never signed in', 'p_orphan', rls_test.prepare('orphan@inv.example.invalid', array['REPORTS_VIEWER']));
select rls_test.expect_call_ok('7. invite an e-mail of an account that has signed in before (no company)', 'p_self', rls_test.prepare('selfsign@inv.example.invalid', array['REPORTS_VIEWER']));
reset role;
select rls_test.ok('7. never-signed-in account is replaced (deleted, then invited: one account remains); signed-in account is attached and sent a password link',
  rls_test.gid('p_orphan', 'replace_auth_user_id') = rls_test.id('orphan') and not (rls_test.get('p_orphan') ->> 'existing_account')::boolean
  and (rls_test.get('p_self') ->> 'existing_account')::boolean and rls_test.gid('p_self', 'existing_auth_user_id') = rls_test.id('selfsign'));
set local role service_role;
select rls_test.expect_call_ok('7. existing account attached (password-link delivery)', 'f_self',
  format('select public.user_invitation_finalize(%L, %L, ''PASSWORD_LINK'')', rls_test.gid('p_self', 'invitation_id'), rls_test.id('selfsign')));
reset role;
select rls_test.ok('7. no second account: the existing user gets the company and role, inactive until accepted',
  (select count(*) from auth.users where email = 'selfsign@inv.example.invalid') = 1
  and (rls_test.profile(rls_test.id('selfsign'))).company_id = rls_test.id('company_a') and rls_test.roles_of(rls_test.id('selfsign')) = array['REPORTS_VIEWER']
  and (rls_test.inv(rls_test.gid('p_self', 'invitation_id'))).delivery_method = 'PASSWORD_LINK');

-- ---------------------------------------------------------------------------
-- 11. Revoked; 12. expired; 13. resend; failure
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('sa');
select rls_test.expect_call_ok('11. invite rev@', 'p_rev', rls_test.prepare('rev@inv.example.invalid', array['STORE_EXECUTIVE']));
select rls_test.expect_call_ok('12. invite exp@', 'p_exp', rls_test.prepare('exp@inv.example.invalid', array['DISPATCH_EXECUTIVE']));
select rls_test.expect_call_ok('invite fail@', 'p_fail', rls_test.prepare('fail@inv.example.invalid', array['REPORTS_VIEWER']));
reset role;
select rls_test.auth_user('rev', 'rev@inv.example.invalid');
select rls_test.auth_user('exp', 'exp@inv.example.invalid');
set local role service_role;
select rls_test.call(format('select public.user_invitation_finalize(%L, %L)', rls_test.gid('p_rev', 'invitation_id'), rls_test.id('rev')));
select rls_test.call(format('select public.user_invitation_finalize(%L, %L)', rls_test.gid('p_exp', 'invitation_id'), rls_test.id('exp')));
select rls_test.expect_call_ok('e-mail delivery failed: recorded (service role)', 'f_fail', format('select public.user_invitation_fail(%L, %L)', rls_test.gid('p_fail', 'invitation_id'), 'SMTP rejected the message'));
reset role;
set local role authenticated;
select rls_test.claims('adm');
select rls_test.expect_call_ok('11. revoke rev@', 'rv', format('select public.user_invitation_revoke(%L, %L)', rls_test.gid('p_rev', 'invitation_id'), 'Hired elsewhere'));
select rls_test.expect_call_error('11. an accepted invitation cannot be revoked', format('select public.user_invitation_revoke(%L, %L)', rls_test.gid('p1', 'invitation_id'), 'Mistake'), 'already accepted');
select rls_test.claims('rev');
select rls_test.expect_call_error('11. the revoked link cannot be accepted', 'select public.user_invitation_accept()', 'revoked');
reset role;
select rls_test.ok('11. revoked: status REVOKED with reason, roles removed, account detached from the company, Auth user to delete (never signed in), audited',
  (rls_test.inv(rls_test.gid('p_rev', 'invitation_id'))).status = 'REVOKED' and (rls_test.inv(rls_test.gid('p_rev', 'invitation_id'))).revoke_reason = 'Hired elsewhere'
  and rls_test.roles_of(rls_test.id('rev')) = '{}' and (rls_test.profile(rls_test.id('rev'))).company_id is null and not (rls_test.profile(rls_test.id('rev'))).is_active
  and (rls_test.get('rv') ->> 'delete_auth_user')::boolean and rls_test.audits('user.invitation_revoked') = 1, rls_test.get('rv')::text);

update public.user_invitations set expires_at = now() - interval '1 hour' where id = rls_test.gid('p_exp', 'invitation_id');
set local role authenticated;
select rls_test.claims('exp');
select rls_test.expect_call_ok('12. accepting an expired invitation', 'acc_exp', 'select public.user_invitation_accept()');
select rls_test.claims('sa');
select rls_test.expect_call_ok('invitation list', 'list1', 'select public.user_invitations_list()');
reset role;
select rls_test.ok('12. expired: refused, account stays inactive, invitation EXPIRED',
  rls_test.get('acc_exp') ->> 'status' = 'EXPIRED' and not (rls_test.profile(rls_test.id('exp'))).is_active
  and (rls_test.inv(rls_test.gid('p_exp', 'invitation_id'))).status = 'EXPIRED', rls_test.get('acc_exp')::text);
select rls_test.ok('failure: invitation FAILED, e-mail FAILED with the reason, audited',
  (rls_test.inv(rls_test.gid('p_fail', 'invitation_id'))).status = 'FAILED' and (rls_test.inv(rls_test.gid('p_fail', 'invitation_id'))).email_status = 'FAILED'
  and (rls_test.inv(rls_test.gid('p_fail', 'invitation_id'))).email_error = 'SMTP rejected the message' and rls_test.audits('user.invitation_failed') = 1);
select rls_test.ok('list: name, e-mail, roles, dates, inviter, expiry, status and e-mail status for every invitation',
  jsonb_array_length(rls_test.get('list1')) = 7
  and exists (select 1 from jsonb_array_elements(rls_test.get('list1')) x where x ->> 'email' = 'new@inv.example.invalid' and x ->> 'status' = 'ACCEPTED'
              and x ->> 'invited_by' = 'Asha Admin' and x -> 'roles' -> 0 ->> 'name' is not null and x ->> 'employee_id' = 'EMP-101' and x ->> 'reporting_manager' = 'Asha Admin')
  and exists (select 1 from jsonb_array_elements(rls_test.get('list1')) x where x ->> 'email' = 'fail@inv.example.invalid' and x ->> 'email_status' = 'FAILED'));

-- 13. Resend the expired invitation: old never-used Auth user replaced, one account remains.
set local role authenticated;
select rls_test.claims('sa');
select rls_test.expect_call_ok('13. resend the expired invitation', 'rs', format('select public.user_invitation_prepare(null, null, null, null, %L, ''RESEND'', %L)',
  gen_random_uuid(), rls_test.gid('p_exp', 'invitation_id')));
select rls_test.expect_call_error('13. an accepted invitation cannot be resent', format('select public.user_invitation_prepare(null, null, null, null, %L, ''RESEND'', %L)',
  gen_random_uuid(), rls_test.gid('p1', 'invitation_id')), 'accepted');
reset role;
-- invite-user: delete the old never-signed-in Auth user, invite again (new Auth user), finalize.
delete from auth.users where id = rls_test.gid('rs', 'replace_auth_user_id');
select rls_test.auth_user('exp2', 'exp@inv.example.invalid');
set local role service_role;
select rls_test.expect_call_ok('13. resent e-mail finalized', 'rs_f', format('select public.user_invitation_finalize(%L, %L)', rls_test.gid('p_exp', 'invitation_id'), rls_test.id('exp2')));
reset role;
select rls_test.ok('13. resend: PENDING again with a new expiry, sent twice, audited as a resend, exactly one account for the e-mail with the role',
  rls_test.gid('rs', 'replace_auth_user_id') = rls_test.id('exp') and (rls_test.inv(rls_test.gid('p_exp', 'invitation_id'))).status = 'PENDING'
  and (rls_test.inv(rls_test.gid('p_exp', 'invitation_id'))).expires_at > now() and (rls_test.inv(rls_test.gid('p_exp', 'invitation_id'))).send_count = 2
  and rls_test.audits('user.invitation_resent') = 1 and (select count(*) from auth.users where email = 'exp@inv.example.invalid') = 1
  and rls_test.roles_of(rls_test.id('exp2')) = array['DISPATCH_EXECUTIVE'], rls_test.get('rs_f')::text);
set local role authenticated;
select rls_test.claims('exp2');
select rls_test.expect_call_ok('13. the resent link activates the account', 'acc_rs', 'select public.user_invitation_accept()');
reset role;
select rls_test.ok('13. resent invitation accepted', rls_test.get('acc_rs') ->> 'status' = 'ACCEPTED' and (rls_test.profile(rls_test.id('exp2'))).is_active);

-- ---------------------------------------------------------------------------
-- Role edits after activation; grants; RLS; rate limiting
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('adm');
select rls_test.expect_call_error('edit roles: an Administrator cannot grant the Administrator role directly',
  format('insert into public.user_roles (user_id, company_id, role_id, assigned_by) values (%L, %L, %L, %L) returning jsonb_build_object(''id'', id)',
    rls_test.id('member'), rls_test.id('company_a'), rls_test.id('role_admin'), rls_test.id('adm')), 'row-level security');
select rls_test.expect_call_ok('edit roles: an Administrator can grant a non-admin role', 'g_ok',
  format('insert into public.user_roles (user_id, company_id, role_id, assigned_by) values (%L, %L, %L, %L) returning jsonb_build_object(''id'', id)',
    rls_test.id('member'), rls_test.id('company_a'), rls_test.id('role_reports_viewer'), rls_test.id('adm')));
select rls_test.expect_call_error('edit roles: nobody grants themselves a role',
  format('insert into public.user_roles (user_id, company_id, role_id, assigned_by) values (%L, %L, %L, %L) returning jsonb_build_object(''id'', id)',
    rls_test.id('adm'), rls_test.id('company_a'), rls_test.id('role_accounts_manager'), rls_test.id('adm')), 'row-level security');
select rls_test.expect_call_error('grants: finalize is not callable by signed-in users', format('select public.user_invitation_finalize(%L, %L)', rls_test.gid('p2', 'invitation_id'), rls_test.id('adm')), 'permission denied');
select rls_test.expect_call_error('grants: invitations cannot be written directly',
  format('update public.user_invitations set status = ''ACCEPTED'' where id = %L returning jsonb_build_object(''id'', id)', rls_test.gid('p2', 'invitation_id')), 'permission denied');
select rls_test.claims('sa');
select rls_test.expect_call_ok('edit roles: a Super Admin can grant the Administrator role', 'g_admin',
  format('insert into public.user_roles (user_id, company_id, role_id, assigned_by) values (%L, %L, %L, %L) returning jsonb_build_object(''id'', id)',
    rls_test.id('member'), rls_test.id('company_a'), rls_test.id('role_admin'), rls_test.id('sa')));
select rls_test.claims('viewer');
select rls_test.set('v_rows', rls_test.call('select to_jsonb(count(*)) from public.user_invitations'));
reset role;
select rls_test.ok('RLS: a user without users.manage reads no invitations', rls_test.get('v_rows') = '0'::jsonb);
select rls_test.ok('grants: anon cannot call any invitation function; the service-role steps are not granted to authenticated',
  not has_function_privilege('anon', 'public.user_invitation_prepare(text, text, jsonb, uuid[], uuid, text, uuid, int)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.user_invitation_accept()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.user_invitation_fail(uuid, text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.user_invitation_finalize(uuid, uuid, text)', 'EXECUTE'));
select rls_test.ok('15. audit trail: invitations, resend, revocation, failure and activations recorded',
  rls_test.audits('user.invited') >= 4 and rls_test.audits('user.invitation_resent') = 1 and rls_test.audits('user.invitation_revoked') = 1
  and rls_test.audits('user.invitation_failed') = 1 and rls_test.audits('user.invitation_accepted') = 2);
select rls_test.ok('security: no invitation token or link is stored',
  not exists (select 1 from information_schema.columns where table_name = 'user_invitations' and column_name ~ '(token|link|secret)'));

-- Abuse protection: at most 30 invitations per inviter per hour.
insert into public.user_invitations (company_id, email, full_name, role_ids, invited_by, expires_at, idempotency_key, status)
select rls_test.id('company_a'), 'bulk' || g || '@inv.example.invalid', 'Bulk ' || g, array[rls_test.id('role_reports_viewer')], rls_test.id('adm'),
  now() + interval '1 day', gen_random_uuid(), 'REVOKED' from generate_series(1, 30) g;
set local role authenticated;
select rls_test.claims('adm');
select rls_test.expect_call_error('rate limit: the 31st invitation within an hour is refused', rls_test.prepare('late@inv.example.invalid', array['REPORTS_VIEWER']), 'Too many');
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
  raise exception 'USER_INVITATIONS_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
