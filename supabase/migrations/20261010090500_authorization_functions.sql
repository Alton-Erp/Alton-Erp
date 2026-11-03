-- =============================================================================
-- Authorization helpers.
--
-- private.* helpers are SECURITY DEFINER so RLS policies can consult profiles,
-- user_roles and role_permissions without recursive policy evaluation. Each one
-- only answers a yes/no question about the CALLER (auth.uid()), never returns
-- other users' data, has a fixed empty search_path, and is executable only by
-- `authenticated` (anon gets nothing). The `private` schema is not exposed via
-- the Data API.
--
-- A user is an "active member" of a company only when:
--   profile.is_active AND profile.company_id = company AND company.is_active
-- Inactive users and users without a profile therefore match no policy.
-- =============================================================================

create or replace function private.is_active_member(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.companies c on c.id = p.company_id
    where p.id = auth.uid()
      and p.company_id = p_company_id
      and p.is_active
      and c.is_active
  );
$$;

create or replace function private.has_permission(p_company_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_active_member(p_company_id)
    and exists (
      select 1
      from public.user_roles ur
      join public.role_permissions rp on rp.role_id = ur.role_id
      join public.permissions perm on perm.id = rp.permission_id
      where ur.user_id = auth.uid()
        and ur.company_id = p_company_id
        and perm.code = p_permission
    );
$$;

create or replace function private.has_role(p_company_id uuid, p_role_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_active_member(p_company_id)
    and exists (
      select 1
      from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      where ur.user_id = auth.uid()
        and ur.company_id = p_company_id
        and r.code = p_role_code
    );
$$;

-- Whether ANOTHER user holds a role. Used to protect Super Admin accounts from
-- being deactivated or stripped by lower-privileged administrators.
create or replace function private.user_has_role(p_user_id uuid, p_company_id uuid, p_role_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.user_id = p_user_id
      and ur.company_id = p_company_id
      and r.code = p_role_code
  );
$$;

create or replace function private.role_code(p_role_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select code from public.roles where id = p_role_id;
$$;

-- The caller's company, only if their profile and company are active.
create or replace function private.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.company_id
  from public.profiles p
  join public.companies c on c.id = p.company_id
  where p.id = auth.uid() and p.is_active and c.is_active;
$$;

revoke all on function private.is_active_member(uuid) from public, anon;
revoke all on function private.has_permission(uuid, text) from public, anon;
revoke all on function private.has_role(uuid, text) from public, anon;
revoke all on function private.user_has_role(uuid, uuid, text) from public, anon;
revoke all on function private.role_code(uuid) from public, anon;
revoke all on function private.current_company_id() from public, anon;

grant execute on function private.is_active_member(uuid) to authenticated;
grant execute on function private.has_permission(uuid, text) to authenticated;
grant execute on function private.has_role(uuid, text) to authenticated;
grant execute on function private.user_has_role(uuid, uuid, text) to authenticated;
grant execute on function private.role_code(uuid) to authenticated;
grant execute on function private.current_company_id() to authenticated;

-- =============================================================================
-- Public RPCs (callable through the Data API by signed-in users only).
-- =============================================================================

-- The caller's own access summary, used by the frontend after sign-in.
-- Returns only the caller's data. Roles/permissions are returned only when the
-- profile and company are active; the frontend shows an account-status screen
-- otherwise. This is a UX convenience: RLS remains the security boundary.
create or replace function public.get_my_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_profile  public.profiles;
  v_company  public.companies;
  v_active   boolean;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_profile from public.profiles where id = v_uid;
  if not found then
    return jsonb_build_object('profile', null, 'company', null, 'roles', '[]'::jsonb, 'permissions', '[]'::jsonb);
  end if;

  if v_profile.company_id is not null then
    select * into v_company from public.companies where id = v_profile.company_id;
  end if;

  v_active := v_profile.is_active and v_company.id is not null and v_company.is_active;

  return jsonb_build_object(
    'profile', jsonb_build_object(
      'id', v_profile.id,
      'email', v_profile.email,
      'full_name', v_profile.full_name,
      'company_id', v_profile.company_id,
      'is_active', v_profile.is_active
    ),
    'company', case when v_company.id is null then null else jsonb_build_object(
      'id', v_company.id,
      'legal_name', v_company.legal_name,
      'display_name', v_company.display_name,
      'company_code', v_company.company_code,
      'currency_code', v_company.currency_code,
      'timezone', v_company.timezone,
      'is_active', v_company.is_active
    ) end,
    'roles', case when not v_active then '[]'::jsonb else coalesce((
      select jsonb_agg(r.code order by r.code)
      from public.user_roles ur join public.roles r on r.id = ur.role_id
      where ur.user_id = v_uid and ur.company_id = v_profile.company_id
    ), '[]'::jsonb) end,
    'permissions', case when not v_active then '[]'::jsonb else coalesce((
      select jsonb_agg(distinct perm.code)
      from public.user_roles ur
      join public.role_permissions rp on rp.role_id = ur.role_id
      join public.permissions perm on perm.id = rp.permission_id
      where ur.user_id = v_uid and ur.company_id = v_profile.company_id
    ), '[]'::jsonb) end
  );
end;
$$;

revoke all on function public.get_my_access() from public, anon;
grant execute on function public.get_my_access() to authenticated;

-- Server-side permission check for trusted callers (e.g. Edge Functions acting
-- with the caller's JWT). Answers only for the caller's own active company.
create or replace function public.current_user_has_permission(p_permission text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(private.has_permission(private.current_company_id(), p_permission), false);
$$;

revoke all on function public.current_user_has_permission(text) from public, anon;
grant execute on function public.current_user_has_permission(text) to authenticated;

-- Lets the frontend record a small allow-listed set of authentication events.
-- Actor and company are derived server-side; metadata is reduced to allow-listed
-- short string fields; per-user rate limited to protect the log from flooding.
create or replace function public.log_security_event(p_action text, p_metadata jsonb default '{}'::jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_company uuid;
  v_meta    jsonb := '{}'::jsonb;
  v_key     text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if p_action not in ('auth.sign_in', 'auth.sign_out', 'auth.access_denied', 'auth.password_changed') then
    raise exception 'Event type not allowed' using errcode = '22023';
  end if;

  -- At most 30 client-reported events per user per minute.
  if (select count(*) from public.audit_logs
      where actor_user_id = v_uid and event_timestamp > now() - interval '1 minute'
        and action like 'auth.%') >= 30 then
    return;
  end if;

  foreach v_key in array array['path', 'reason'] loop
    if jsonb_typeof(p_metadata -> v_key) = 'string' then
      v_meta := v_meta || jsonb_build_object(v_key, left(p_metadata ->> v_key, 200));
    end if;
  end loop;

  select company_id into v_company from public.profiles where id = v_uid;

  perform private.write_audit_log(v_company, p_action, 'auth', v_uid::text, v_meta);
end;
$$;

revoke all on function public.log_security_event(text, jsonb) from public, anon;
grant execute on function public.log_security_event(text, jsonb) to authenticated;
