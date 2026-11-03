-- Rollback of 20261116090000_user_invitations.sql
-- Removes the invitation workflow (functions, user_invitations table) and restores the
-- previous role-assignment policy and ERP reset lists.
--
-- Kept on purpose:
--   * the 13 functional roles and their permissions (users may already hold them;
--     removing a role that is assigned is refused by the user_roles foreign key)
--   * every profile, Auth user and role assignment created by invitations
--   * the audit log rows of invitations, resends, revocations and activations
-- Dropped: public.user_invitations (invitation records). Its history stays in audit_logs.
-- Invited users who have not yet activated stay inactive; activate them on the Users page.
--
-- Order: roll this back BEFORE any earlier migration that redefines the ERP reset
-- table lists (20261031090000, 20261113090000), newest first.

begin;

drop function if exists public.user_invitations_list();
drop function if exists public.user_invitation_accept();
drop function if exists public.my_invitation();
drop function if exists public.user_invitation_revoke(uuid, text);
drop function if exists public.user_invitation_fail(uuid, text);
drop function if exists public.user_invitation_finalize(uuid, uuid, text);
drop function if exists public.user_invitation_prepare(text, text, jsonb, uuid[], uuid, text, uuid, int);
drop function if exists public.invite_role_catalog();

drop policy if exists user_roles_insert_company_admin on public.user_roles;
create policy user_roles_insert_company_admin on public.user_roles
  for insert to authenticated
  with check (
    private.has_permission(company_id, 'users.manage')
    and user_id <> auth.uid()
    and assigned_by = auth.uid()
    and (private.role_code(role_id) <> 'SUPER_ADMIN' or private.has_role(company_id, 'SUPER_ADMIN'))
  );

drop table if exists public.user_invitations;

create or replace function private.erp_reset_kept_tables()
returns table (table_name text, label text, company_scoped boolean)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('companies', 'Company record', true),
    ('company_settings', 'Company settings', true),
    ('profiles', 'User profiles', true),
    ('user_roles', 'Role assignments', true),
    ('roles', 'Roles', false),
    ('permissions', 'Permissions', false),
    ('role_permissions', 'Role permissions', false),
    ('audit_logs', 'Audit log', true),
    ('erp_reset_runs', 'Reset history', true),
    ('erp_reset_backup_attestations', 'Reset backup records', true),
    ('invoice_settings', 'Invoice settings', true),
    ('billing_number_sequences', 'Billing number series', true),
    ('inventory_number_sequences', 'Inventory number series', true),
    ('approval_workflows', 'Approval workflows', true),
    ('approval_workflow_stages', 'Approval workflow stages', true),
    ('notification_preferences', 'Notification preferences', true),
    ('notification_sync_state', 'Notification sync state', true),
    ('error_events', 'System error log', true),
    ('amazon_settings', 'Amazon settings', true),
    ('amazon_connections', 'Amazon connections', true),
    ('warehouses', 'Warehouses', true),
    ('inventory_locations', 'Warehouse locations', true),
    ('products', 'Products', true),
    ('product_categories', 'Product categories', true),
    ('documents', 'Documents', true),
    ('document_versions', 'Document files', true)
  ) t (table_name, label, company_scoped);
$$;

create or replace function private.erp_force_reset_retained_tables()
returns table (table_name text, label text, company_scoped boolean, reason text)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('companies', 'Company record', true, 'Needed to sign in to the ERP.'),
    ('company_settings', 'Company settings', true, 'Needed for the application to operate.'),
    ('profiles', 'User profiles', true, 'Every user account is kept.'),
    ('user_roles', 'Role assignments', true, 'Every role assignment is kept, including all Super Admins.'),
    ('roles', 'Roles', false, 'Access control.'),
    ('permissions', 'Permissions', false, 'Access control.'),
    ('role_permissions', 'Role permissions', false, 'Access control.'),
    ('audit_logs', 'Audit log', true, 'Security record; it also records this reset.'),
    ('erp_reset_runs', 'Reset history', true, 'Immutable record of every reset attempt.'),
    ('erp_reset_backup_attestations', 'Reset backup records', true, 'Record of the backup taken before the reset.'),
    ('invoice_settings', 'Invoice settings', true, 'Configuration.'),
    ('billing_number_sequences', 'Billing number series', true, 'Configuration; numbers continue and never repeat numbers in the audit log.'),
    ('inventory_number_sequences', 'Inventory number series', true, 'Configuration; numbers continue and never repeat numbers in the audit log.'),
    ('approval_workflows', 'Approval workflows', true, 'Configuration.'),
    ('approval_workflow_stages', 'Approval workflow stages', true, 'Configuration.'),
    ('notification_preferences', 'Notification preferences', true, 'User settings.'),
    ('notification_sync_state', 'Notification sync state', true, 'System state.'),
    ('error_events', 'System error log', true, 'Diagnostic and security record.'),
    ('amazon_settings', 'Amazon settings', true, 'Configuration.'),
    ('amazon_connections', 'Amazon connections', true, 'Integration configuration (no business data).')
  ) t (table_name, label, company_scoped, reason);
$$;

drop function if exists private.role_assignment_problem(uuid, uuid, uuid[]);
drop function if exists private.actor_has_permission(uuid, uuid, text);
drop function if exists private.actor_has_role(uuid, uuid, text);
drop function if exists private.role_is_admin(uuid);
drop function if exists private.role_category(text);

-- Optional (only if no user holds them): remove the 13 functional roles.
-- delete from public.roles where code in ('ACCOUNTS_EXECUTIVE', 'SALES_EXECUTIVE', 'BILLING_MANAGER', 'PURCHASE_EXECUTIVE', 'WAREHOUSE_MANAGER',
--   'STORE_EXECUTIVE', 'PRODUCTION_EXECUTIVE', 'QUALITY_CONTROL', 'DISPATCH_MANAGER', 'DISPATCH_EXECUTIVE', 'LEGAL_COMPLIANCE', 'HR_MANAGER', 'REPORTS_VIEWER')
--   and not exists (select 1 from public.user_roles ur where ur.role_id = roles.id);

notify pgrst, 'reload schema';

commit;
