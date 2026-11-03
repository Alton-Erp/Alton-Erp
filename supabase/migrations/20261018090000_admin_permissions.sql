-- =============================================================================
-- Phase 10: administration & productivity permissions
--
-- Reused (Phase 2): users.manage (user activity, session revocation),
-- settings.manage (ERP settings), audit_logs.read (audit viewer),
-- products.read / products.update (labels, barcode assignment).
-- New: approvals.read (approval inbox, deciding requests assigned to one's
-- role), approvals.manage (configure workflows, cancel any request),
-- documents.read / .upload / .manage, bulk_operations.read (import history of
-- all users), system_health.read.
-- =============================================================================

insert into public.permissions (resource, action, description) values
  ('approvals',       'read',   'View the approval inbox and decide requests assigned to your role or to you'),
  ('approvals',       'manage', 'Configure approval workflows and cancel any approval request'),
  ('documents',       'read',   'View and download documents attached to records you can open'),
  ('documents',       'upload', 'Upload documents and new revisions to records you can open'),
  ('documents',       'manage', 'Archive any document'),
  ('bulk_operations', 'read',   'View import history and error reports of all users'),
  ('system_health',   'read',   'View system health, integration status and error logs')
on conflict (code) do nothing;

with matrix (role_code, permission_code) as (
  values
    ('ADMIN', 'approvals.read'), ('ADMIN', 'approvals.manage'), ('ADMIN', 'documents.read'), ('ADMIN', 'documents.upload'),
    ('ADMIN', 'documents.manage'), ('ADMIN', 'bulk_operations.read'), ('ADMIN', 'system_health.read'),

    ('INVENTORY_MANAGER', 'approvals.read'), ('INVENTORY_MANAGER', 'documents.read'), ('INVENTORY_MANAGER', 'documents.upload'),
    ('INVENTORY_MANAGER', 'bulk_operations.read'),
    ('PRODUCTION_MANAGER', 'approvals.read'), ('PRODUCTION_MANAGER', 'documents.read'), ('PRODUCTION_MANAGER', 'documents.upload'),
    ('PURCHASE_MANAGER', 'approvals.read'), ('PURCHASE_MANAGER', 'documents.read'), ('PURCHASE_MANAGER', 'documents.upload'),
    ('SALES_MANAGER', 'approvals.read'), ('SALES_MANAGER', 'documents.read'), ('SALES_MANAGER', 'documents.upload'),
    ('SALES_MANAGER', 'bulk_operations.read'),
    ('ACCOUNTS_MANAGER', 'approvals.read'), ('ACCOUNTS_MANAGER', 'documents.read'), ('ACCOUNTS_MANAGER', 'documents.upload'),
    ('MANAGEMENT_VIEWER', 'approvals.read'), ('MANAGEMENT_VIEWER', 'documents.read')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from matrix m
join public.roles r on r.code = m.role_code
join public.permissions p on p.code = m.permission_code
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.code = 'SUPER_ADMIN'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Protect the last active Super Admin of a company (deactivation or removal
-- of the role). Applies to every database role, including trusted backends.
-- -----------------------------------------------------------------------------
create or replace function private.other_active_super_admins(p_company uuid, p_user uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int
  from public.user_roles ur
  join public.roles r on r.id = ur.role_id and r.code = 'SUPER_ADMIN'
  join public.profiles p on p.id = ur.user_id and p.is_active and p.company_id = p_company
  where ur.company_id = p_company and ur.user_id <> p_user;
$$;

revoke all on function private.other_active_super_admins(uuid, uuid) from public, anon, authenticated;

create or replace function private.guard_last_super_admin_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_active and not new.is_active and old.company_id is not null
     and private.user_has_role(old.id, old.company_id, 'SUPER_ADMIN')
     and private.other_active_super_admins(old.company_id, old.id) = 0 then
    raise exception 'This is the last active Super Admin of the company and cannot be deactivated. Activate or assign another Super Admin first.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_last_super_admin_profile() from public, anon, authenticated;

drop trigger if exists profiles_guard_last_super_admin on public.profiles;
create trigger profiles_guard_last_super_admin
  before update on public.profiles
  for each row execute function private.guard_last_super_admin_profile();

create or replace function private.guard_last_super_admin_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.role_code(old.role_id) = 'SUPER_ADMIN'
     and exists (select 1 from public.profiles p where p.id = old.user_id and p.is_active and p.company_id = old.company_id)
     and private.other_active_super_admins(old.company_id, old.user_id) = 0 then
    raise exception 'The Super Admin role cannot be removed from the last active Super Admin of the company.' using errcode = '42501';
  end if;
  return old;
end;
$$;

revoke all on function private.guard_last_super_admin_role() from public, anon, authenticated;

drop trigger if exists user_roles_guard_last_super_admin on public.user_roles;
create trigger user_roles_guard_last_super_admin
  before delete on public.user_roles
  for each row execute function private.guard_last_super_admin_role();
