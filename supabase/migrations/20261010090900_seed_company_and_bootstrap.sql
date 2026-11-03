-- =============================================================================
-- Seed the initial company and provide the one-time Super Admin bootstrap.
-- Legal details (GSTIN, address, state, registration numbers) are deliberately
-- left NULL; an administrator enters the verified values in Company Settings.
-- =============================================================================

insert into public.companies (legal_name, display_name, company_code)
values ('Alton Hi-Tech Sanitary Ware Pvt. Ltd.', 'Alton Hi-Tech Sanitary Ware Pvt. Ltd.', 'ALTON')
on conflict (company_code) do nothing;

-- -----------------------------------------------------------------------------
-- private.bootstrap_super_admin(email, company_code)
--
-- Trusted, one-time setup step. Run it from the Supabase SQL Editor (as the
-- database owner) after creating the user in Authentication > Users.
-- It is NOT executable by anon or authenticated, and `private` is not exposed
-- through the Data API, so it cannot be reached from the browser.
-- It refuses to run if the company already has a Super Admin; after that,
-- further Super Admins are granted in-app by an existing Super Admin.
-- -----------------------------------------------------------------------------
create or replace function private.bootstrap_super_admin(p_email text, p_company_code text default 'ALTON')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id    uuid;
  v_company_id uuid;
  v_role_id    uuid;
begin
  select id into v_company_id from public.companies where company_code = p_company_code;
  if v_company_id is null then
    raise exception 'Company % not found', p_company_code;
  end if;

  if exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where ur.company_id = v_company_id and r.code = 'SUPER_ADMIN'
  ) then
    raise exception 'Company % already has a Super Admin. Assign further Super Admins from the application.', p_company_code;
  end if;

  select id into v_user_id from auth.users where lower(email) = lower(btrim(p_email));
  if v_user_id is null then
    raise exception 'No auth user with email %. Create the user in Authentication > Users first.', p_email;
  end if;

  -- The profile normally exists via the auth trigger; create it if the user
  -- pre-dates this migration.
  insert into public.profiles (id, email, company_id, is_active)
  select id, coalesce(email, ''), null, false from auth.users where id = v_user_id
  on conflict (id) do nothing;

  if exists (select 1 from public.profiles where id = v_user_id and company_id is not null and company_id <> v_company_id) then
    raise exception 'User already belongs to another company';
  end if;

  update public.profiles set company_id = v_company_id, is_active = true where id = v_user_id;

  select id into v_role_id from public.roles where code = 'SUPER_ADMIN';
  insert into public.user_roles (user_id, company_id, role_id)
  values (v_user_id, v_company_id, v_role_id)
  on conflict do nothing;

  perform private.write_audit_log(v_company_id, 'security.super_admin_bootstrapped', 'profile', v_user_id::text, '{}'::jsonb);

  return v_user_id;
end;
$$;

revoke all on function private.bootstrap_super_admin(text, text) from public, anon, authenticated, service_role;
