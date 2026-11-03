-- =============================================================================
-- Guard triggers and automatic audit logging for security-relevant changes.
-- Audit rows are written in the same transaction as the change, so a change
-- cannot succeed without its audit entry.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Profile activation guard (applies to client roles only; trusted backend
-- roles such as service_role and the SQL editor's postgres are not restricted).
-- -----------------------------------------------------------------------------
create or replace function private.guard_profile_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if new.is_active is distinct from old.is_active then
    if old.id = auth.uid() then
      raise exception 'You cannot change your own activation status' using errcode = '42501';
    end if;
    if old.company_id is null or not private.has_permission(old.company_id, 'users.manage') then
      raise exception 'Not authorized to change activation status' using errcode = '42501';
    end if;
    if private.user_has_role(old.id, old.company_id, 'SUPER_ADMIN')
       and not private.has_role(old.company_id, 'SUPER_ADMIN') then
      raise exception 'Only a Super Admin can change a Super Admin''s activation status' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.guard_profile_update() from public, anon, authenticated;

drop trigger if exists profiles_guard_update on public.profiles;
create trigger profiles_guard_update
  before update on public.profiles
  for each row execute function private.guard_profile_update();

-- -----------------------------------------------------------------------------
-- Audit: profiles
-- -----------------------------------------------------------------------------
create or replace function private.audit_profile_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.write_audit_log(new.company_id, 'user.provisioned', 'profile', new.id::text, '{}'::jsonb);
    return new;
  end if;

  if new.company_id is distinct from old.company_id then
    perform private.write_audit_log(
      coalesce(new.company_id, old.company_id), 'user.company_changed', 'profile', new.id::text,
      jsonb_build_object('from_company_id', old.company_id, 'to_company_id', new.company_id));
  end if;

  if new.is_active is distinct from old.is_active then
    perform private.write_audit_log(
      new.company_id,
      case when new.is_active then 'user.activated' else 'user.deactivated' end,
      'profile', new.id::text, '{}'::jsonb);
  end if;

  return new;
end;
$$;

revoke all on function private.audit_profile_change() from public, anon, authenticated;

drop trigger if exists profiles_audit on public.profiles;
create trigger profiles_audit
  after insert or update on public.profiles
  for each row execute function private.audit_profile_change();

-- -----------------------------------------------------------------------------
-- Audit: role assignments
-- -----------------------------------------------------------------------------
create or replace function private.audit_user_role_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.user_roles := case when tg_op = 'DELETE' then old else new end;
begin
  perform private.write_audit_log(
    v_row.company_id,
    case when tg_op = 'DELETE' then 'user_role.revoked' else 'user_role.granted' end,
    'user_role', v_row.id::text,
    jsonb_build_object('user_id', v_row.user_id, 'role', private.role_code(v_row.role_id)));
  return null;
end;
$$;

revoke all on function private.audit_user_role_change() from public, anon, authenticated;

drop trigger if exists user_roles_audit on public.user_roles;
create trigger user_roles_audit
  after insert or delete on public.user_roles
  for each row execute function private.audit_user_role_change();

-- -----------------------------------------------------------------------------
-- Audit: company settings (key only; values may be sensitive)
-- -----------------------------------------------------------------------------
create or replace function private.audit_company_setting_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.company_settings := case when tg_op = 'DELETE' then old else new end;
begin
  -- Skip no-op updates.
  if tg_op = 'UPDATE' and new.setting_value is not distinct from old.setting_value then
    return null;
  end if;

  perform private.write_audit_log(
    v_row.company_id,
    case tg_op when 'INSERT' then 'settings.created' when 'UPDATE' then 'settings.updated' else 'settings.deleted' end,
    'company_setting', v_row.id::text,
    jsonb_build_object('setting_key', v_row.setting_key));
  return null;
end;
$$;

revoke all on function private.audit_company_setting_change() from public, anon, authenticated;

drop trigger if exists company_settings_audit on public.company_settings;
create trigger company_settings_audit
  after insert or update or delete on public.company_settings
  for each row execute function private.audit_company_setting_change();

-- -----------------------------------------------------------------------------
-- Audit: company profile (names of changed fields only)
-- -----------------------------------------------------------------------------
create or replace function private.audit_company_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed jsonb;
begin
  select coalesce(jsonb_agg(n.key order by n.key), '[]'::jsonb) into v_changed
  from jsonb_each(to_jsonb(new)) n
  join jsonb_each(to_jsonb(old)) o using (key)
  where n.value is distinct from o.value and n.key not in ('updated_at');

  if jsonb_array_length(v_changed) > 0 then
    perform private.write_audit_log(new.id, 'company.updated', 'company', new.id::text,
      jsonb_build_object('changed_fields', v_changed));
  end if;
  return null;
end;
$$;

revoke all on function private.audit_company_change() from public, anon, authenticated;

drop trigger if exists companies_audit on public.companies;
create trigger companies_audit
  after update on public.companies
  for each row execute function private.audit_company_change();
