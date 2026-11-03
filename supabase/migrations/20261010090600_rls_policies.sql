-- =============================================================================
-- Row Level Security and table privileges.
--
-- Two layers, both required:
--   1. GRANTs: Supabase grants ALL on new public tables to anon/authenticated by
--      default. We revoke that and grant only the operations (and, for UPDATE,
--      only the columns) each table needs.
--   2. RLS policies: decide WHICH rows those operations may touch.
-- anon receives no privileges and no policies on any table in this phase.
-- Writes to the role/permission catalogue and audit log are never granted.
-- =============================================================================

alter table public.companies        enable row level security;
alter table public.company_settings enable row level security;
alter table public.profiles         enable row level security;
alter table public.roles            enable row level security;
alter table public.permissions      enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_roles       enable row level security;
alter table public.audit_logs       enable row level security;

revoke all on table
  public.companies, public.company_settings, public.profiles, public.roles,
  public.permissions, public.role_permissions, public.user_roles, public.audit_logs
from anon, authenticated;

-- service_role (server-side only, bypasses RLS) keeps full access for trusted
-- backend jobs such as the invite Edge Function.
grant all on table
  public.companies, public.company_settings, public.profiles, public.roles,
  public.permissions, public.role_permissions, public.user_roles, public.audit_logs
to service_role;

-- -----------------------------------------------------------------------------
-- companies: members read their own company; settings.manage may edit a
-- limited set of descriptive columns. Code, currency and activation are
-- changed only by trusted backend/SQL.
-- -----------------------------------------------------------------------------
grant select on public.companies to authenticated;
grant update (legal_name, display_name, legal_address, state, country, gstin, timezone)
  on public.companies to authenticated;

drop policy if exists companies_select_member on public.companies;
create policy companies_select_member on public.companies
  for select to authenticated
  using (private.is_active_member(id));

drop policy if exists companies_update_settings_manager on public.companies;
create policy companies_update_settings_manager on public.companies
  for update to authenticated
  using (private.has_permission(id, 'settings.manage'))
  with check (private.has_permission(id, 'settings.manage'));

-- -----------------------------------------------------------------------------
-- company_settings: read and write require settings.manage in that company.
-- -----------------------------------------------------------------------------
grant select, insert, delete on public.company_settings to authenticated;
grant update (setting_value) on public.company_settings to authenticated;

drop policy if exists company_settings_select on public.company_settings;
create policy company_settings_select on public.company_settings
  for select to authenticated
  using (private.has_permission(company_id, 'settings.manage'));

drop policy if exists company_settings_insert on public.company_settings;
create policy company_settings_insert on public.company_settings
  for insert to authenticated
  with check (private.has_permission(company_id, 'settings.manage'));

drop policy if exists company_settings_update on public.company_settings;
create policy company_settings_update on public.company_settings
  for update to authenticated
  using (private.has_permission(company_id, 'settings.manage'))
  with check (private.has_permission(company_id, 'settings.manage'));

drop policy if exists company_settings_delete on public.company_settings;
create policy company_settings_delete on public.company_settings
  for delete to authenticated
  using (private.has_permission(company_id, 'settings.manage'));

-- -----------------------------------------------------------------------------
-- profiles
--   * Everyone signed in may read their OWN profile (even if inactive, so the
--     app can explain why access is blocked).
--   * users.manage / audit_logs.read holders may read profiles in their company.
--   * Column grants allow updating only full_name and is_active; id, email and
--     company_id cannot be changed by clients at all.
--   * Who may change is_active is enforced by trigger (see audit migration):
--     never your own, only with users.manage, and Super Admins only by a
--     Super Admin.
--   * No INSERT/DELETE: profiles are created by the auth trigger and removed
--     with the auth user.
-- -----------------------------------------------------------------------------
grant select on public.profiles to authenticated;
grant update (full_name, is_active) on public.profiles to authenticated;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = auth.uid());

drop policy if exists profiles_select_company_admin on public.profiles;
create policy profiles_select_company_admin on public.profiles
  for select to authenticated
  using (
    company_id is not null
    and (private.has_permission(company_id, 'users.manage')
         or private.has_permission(company_id, 'audit_logs.read'))
  );

drop policy if exists profiles_update_own_name on public.profiles;
create policy profiles_update_own_name on public.profiles
  for update to authenticated
  using (id = auth.uid() and private.is_active_member(company_id))
  with check (id = auth.uid());

drop policy if exists profiles_update_company_admin on public.profiles;
create policy profiles_update_company_admin on public.profiles
  for update to authenticated
  using (company_id is not null and private.has_permission(company_id, 'users.manage'))
  with check (company_id is not null and private.has_permission(company_id, 'users.manage'));

-- -----------------------------------------------------------------------------
-- roles / permissions / role_permissions: read-only catalogue, visible to
-- active members of any company. Never writable by clients.
-- -----------------------------------------------------------------------------
grant select on public.roles, public.permissions, public.role_permissions to authenticated;

drop policy if exists roles_select_members on public.roles;
create policy roles_select_members on public.roles
  for select to authenticated
  using (private.current_company_id() is not null);

drop policy if exists permissions_select_members on public.permissions;
create policy permissions_select_members on public.permissions
  for select to authenticated
  using (private.current_company_id() is not null);

drop policy if exists role_permissions_select_members on public.role_permissions;
create policy role_permissions_select_members on public.role_permissions
  for select to authenticated
  using (private.current_company_id() is not null);

-- -----------------------------------------------------------------------------
-- user_roles
--   * Users read their own assignments; users.manage holders read the company's.
--   * Only users.manage holders may grant/revoke, never for themselves.
--   * SUPER_ADMIN can be granted or revoked only by an existing Super Admin of
--     that company (the very first one is created by the bootstrap procedure).
--   * The composite FK guarantees the target user belongs to company_id.
--   * No UPDATE: change a role by revoking and granting.
-- -----------------------------------------------------------------------------
grant select, insert, delete on public.user_roles to authenticated;

drop policy if exists user_roles_select_own on public.user_roles;
create policy user_roles_select_own on public.user_roles
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists user_roles_select_company_admin on public.user_roles;
create policy user_roles_select_company_admin on public.user_roles
  for select to authenticated
  using (private.has_permission(company_id, 'users.manage'));

drop policy if exists user_roles_insert_company_admin on public.user_roles;
create policy user_roles_insert_company_admin on public.user_roles
  for insert to authenticated
  with check (
    private.has_permission(company_id, 'users.manage')
    and user_id <> auth.uid()
    and assigned_by = auth.uid()
    and (private.role_code(role_id) <> 'SUPER_ADMIN' or private.has_role(company_id, 'SUPER_ADMIN'))
  );

drop policy if exists user_roles_delete_company_admin on public.user_roles;
create policy user_roles_delete_company_admin on public.user_roles
  for delete to authenticated
  using (
    private.has_permission(company_id, 'users.manage')
    and user_id <> auth.uid()
    and (private.role_code(role_id) <> 'SUPER_ADMIN' or private.has_role(company_id, 'SUPER_ADMIN'))
  );

-- -----------------------------------------------------------------------------
-- audit_logs: read with audit_logs.read in that company. No client writes;
-- rows come from triggers and SECURITY DEFINER functions.
-- -----------------------------------------------------------------------------
grant select on public.audit_logs to authenticated;

drop policy if exists audit_logs_select_auditor on public.audit_logs;
create policy audit_logs_select_auditor on public.audit_logs
  for select to authenticated
  using (company_id is not null and private.has_permission(company_id, 'audit_logs.read'));
