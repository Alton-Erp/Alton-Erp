-- =============================================================================
-- ALTON ERP V2 — User invitations and functional roles
--
-- Inspected first; reused: Supabase Auth (auth.users, invite e-mail), profiles
-- (created inactive and company-less by on_auth_user_created), roles /
-- permissions / role_permissions (global catalogue), user_roles (company-scoped,
-- composite FK to the profile's company), audit_logs, notifications.
--
-- 1. Functional roles. The 8 existing roles are kept unchanged and reused:
--      SUPER_ADMIN, ADMIN, MANAGEMENT_VIEWER, ACCOUNTS_MANAGER, SALES_MANAGER,
--      PURCHASE_MANAGER, INVENTORY_MANAGER, PRODUCTION_MANAGER
--    13 missing functional roles are added with EXPLICIT least-privilege
--    permission lists (nothing is granted because of a role's name):
--      ACCOUNTS_EXECUTIVE, SALES_EXECUTIVE, BILLING_MANAGER, PURCHASE_EXECUTIVE,
--      WAREHOUSE_MANAGER, STORE_EXECUTIVE, PRODUCTION_EXECUTIVE, QUALITY_CONTROL,
--      DISPATCH_MANAGER, DISPATCH_EXECUTIVE, LEGAL_COMPLIANCE, HR_MANAGER, REPORTS_VIEWER
--    "Administrative" roles = roles holding users.manage, settings.manage,
--    system.reset_data, approvals.manage, billing_settings.manage or
--    amazon_integration.manage (today: SUPER_ADMIN, ADMIN). Only a Super Admin of
--    the company may assign them (invitations AND direct role edits).
-- 2. public.user_invitations: one row per invitation (company, e-mail, roles,
--    employee details, inviter, status, expiry, e-mail status, Auth user reference).
--    No invitation token is stored: the secure link is issued and verified by
--    Supabase Auth. One PENDING invitation per company and e-mail.
-- 3. Functions (all permission checks server-side, caller from auth.uid()):
--      invite_role_catalog()                      roles with category, modules,
--                                                 permissions, admin flag, assignable
--      user_invitation_prepare(...)               validates and records an invitation
--                                                 or a resend (called by invite-user
--                                                 with the caller's own JWT)
--      user_invitation_finalize / _fail           service_role only (invite-user)
--      user_invitation_revoke(...)                revoke a pending invitation
--      my_invitation(), user_invitation_accept()  the invited user's onboarding
--      user_invitations_list()                    invitation management
-- 4. user_roles insert policy: administrative roles need a Super Admin.
-- Existing users, profiles, role assignments and permissions are not changed.
-- Rollback: supabase/rollback/20261116090000_user_invitations_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Functional roles (new roles only; existing roles and grants untouched)
-- -----------------------------------------------------------------------------
insert into public.roles (code, name, description) values
  ('ACCOUNTS_EXECUTIVE',   'Accounts Executive / Accountant', 'Prepares invoices, records customer and supplier payments and credit/debit note drafts. Cannot issue, cancel or reverse.'),
  ('SALES_EXECUTIVE',      'Sales Executive',                 'Creates and updates sales orders and imports customer POs. Cannot confirm or cancel orders.'),
  ('BILLING_MANAGER',      'Billing & Invoicing Manager',     'Creates, posts and cancels invoices (posting dispatches the goods), credit and debit notes, billing reports.'),
  ('PURCHASE_EXECUTIVE',   'Purchase Executive',              'Prepares purchase orders and records goods receipts. Cannot approve, amend or cancel purchase orders.'),
  ('WAREHOUSE_MANAGER',    'Warehouse Manager',               'Warehouses, locations, receipts, transfers, counts, picking, packing and dispatch. Adjustment approval stays with the Inventory Manager.'),
  ('STORE_EXECUTIVE',      'Store Executive',                 'Day-to-day store work: receipts, material issues, transfers, counts, picking and packing.'),
  ('PRODUCTION_EXECUTIVE', 'Production Executive',            'Creates and runs production orders, issues materials and records output. Cannot approve, cancel or complete orders.'),
  ('QUALITY_CONTROL',      'Quality Control',                 'Records production output with rejections, inspects customer returns, views production and stock quality data.'),
  ('DISPATCH_MANAGER',     'Dispatch Manager',                'Picking, packing, dispatch, deliveries, returns receipt and fulfilment reports.'),
  ('DISPATCH_EXECUTIVE',   'Dispatch Executive',              'Picking, packing, dispatch and delivery updates.'),
  ('LEGAL_COMPLIANCE',     'Legal & Compliance Manager',      'Read-only access to the audit log, documents, invoices, ledgers and orders; can upload documents.'),
  ('HR_MANAGER',           'HR Manager',                      'Dashboard and documents. There is no HR module yet; user administration stays with Administrators.'),
  ('REPORTS_VIEWER',       'Reports Viewer',                  'Read-only dashboards and reports (inventory, production, billing, fulfilment). No create, edit, delete or posting.')
on conflict (code) do nothing;

with matrix (role_code, permission_code) as (
  values
    ('ACCOUNTS_EXECUTIVE', 'dashboard.read'), ('ACCOUNTS_EXECUTIVE', 'reports.read'), ('ACCOUNTS_EXECUTIVE', 'invoices.read'), ('ACCOUNTS_EXECUTIVE', 'invoices.create'),
    ('ACCOUNTS_EXECUTIVE', 'invoice_adjustments.create'), ('ACCOUNTS_EXECUTIVE', 'payments.read'), ('ACCOUNTS_EXECUTIVE', 'payments.manage'),
    ('ACCOUNTS_EXECUTIVE', 'supplier_payment.manage'), ('ACCOUNTS_EXECUTIVE', 'billing_reports.read'), ('ACCOUNTS_EXECUTIVE', 'ledger.read'),
    ('ACCOUNTS_EXECUTIVE', 'customers.read'), ('ACCOUNTS_EXECUTIVE', 'suppliers.read'), ('ACCOUNTS_EXECUTIVE', 'sales_orders.read'), ('ACCOUNTS_EXECUTIVE', 'purchases.read'),
    ('ACCOUNTS_EXECUTIVE', 'documents.read'), ('ACCOUNTS_EXECUTIVE', 'documents.upload'), ('ACCOUNTS_EXECUTIVE', 'approvals.read'),

    ('SALES_EXECUTIVE', 'dashboard.read'), ('SALES_EXECUTIVE', 'reports.read'), ('SALES_EXECUTIVE', 'sales_orders.read'), ('SALES_EXECUTIVE', 'sales_orders.create'),
    ('SALES_EXECUTIVE', 'sales_orders.update'), ('SALES_EXECUTIVE', 'customers.read'), ('SALES_EXECUTIVE', 'customer_po.read'), ('SALES_EXECUTIVE', 'customer_po.import'),
    ('SALES_EXECUTIVE', 'customer_po.match'), ('SALES_EXECUTIVE', 'products.read'), ('SALES_EXECUTIVE', 'inventory.read'), ('SALES_EXECUTIVE', 'fulfilment.read'),
    ('SALES_EXECUTIVE', 'invoices.read'), ('SALES_EXECUTIVE', 'ledger.read'), ('SALES_EXECUTIVE', 'documents.read'), ('SALES_EXECUTIVE', 'documents.upload'),
    ('SALES_EXECUTIVE', 'approvals.read'),

    ('BILLING_MANAGER', 'dashboard.read'), ('BILLING_MANAGER', 'reports.read'), ('BILLING_MANAGER', 'invoices.read'), ('BILLING_MANAGER', 'invoices.create'),
    ('BILLING_MANAGER', 'invoices.issue'), ('BILLING_MANAGER', 'invoices.cancel'), ('BILLING_MANAGER', 'invoice_adjustments.create'), ('BILLING_MANAGER', 'invoice_adjustments.issue'),
    ('BILLING_MANAGER', 'billing_reports.read'), ('BILLING_MANAGER', 'billing_reports.export'), ('BILLING_MANAGER', 'payments.read'), ('BILLING_MANAGER', 'customers.read'),
    ('BILLING_MANAGER', 'sales_orders.read'), ('BILLING_MANAGER', 'products.read'), ('BILLING_MANAGER', 'inventory.read'), ('BILLING_MANAGER', 'ledger.read'),
    -- Posting a sales-order invoice dispatches its goods (20261115), which needs these three.
    ('BILLING_MANAGER', 'fulfilment.read'), ('BILLING_MANAGER', 'fulfilment.pick'), ('BILLING_MANAGER', 'fulfilment.pack'), ('BILLING_MANAGER', 'fulfilment.dispatch'),
    ('BILLING_MANAGER', 'documents.read'), ('BILLING_MANAGER', 'documents.upload'), ('BILLING_MANAGER', 'approvals.read'),

    ('PURCHASE_EXECUTIVE', 'dashboard.read'), ('PURCHASE_EXECUTIVE', 'reports.read'), ('PURCHASE_EXECUTIVE', 'purchases.read'), ('PURCHASE_EXECUTIVE', 'purchase_order.create'),
    ('PURCHASE_EXECUTIVE', 'purchase_order.update'), ('PURCHASE_EXECUTIVE', 'purchase_order.export'), ('PURCHASE_EXECUTIVE', 'purchase_receipt.create'),
    ('PURCHASE_EXECUTIVE', 'suppliers.read'), ('PURCHASE_EXECUTIVE', 'products.read'), ('PURCHASE_EXECUTIVE', 'inventory.read'), ('PURCHASE_EXECUTIVE', 'outsourcing.read'),
    ('PURCHASE_EXECUTIVE', 'ledger.read'), ('PURCHASE_EXECUTIVE', 'documents.read'), ('PURCHASE_EXECUTIVE', 'documents.upload'), ('PURCHASE_EXECUTIVE', 'approvals.read'),

    ('WAREHOUSE_MANAGER', 'dashboard.read'), ('WAREHOUSE_MANAGER', 'reports.read'), ('WAREHOUSE_MANAGER', 'inventory.read'), ('WAREHOUSE_MANAGER', 'inventory.create'),
    ('WAREHOUSE_MANAGER', 'inventory.adjust'), ('WAREHOUSE_MANAGER', 'inventory.export'), ('WAREHOUSE_MANAGER', 'inventory_alerts.acknowledge'), ('WAREHOUSE_MANAGER', 'inventory_batch.read'),
    ('WAREHOUSE_MANAGER', 'inventory_count.create'), ('WAREHOUSE_MANAGER', 'inventory_count.approve'), ('WAREHOUSE_MANAGER', 'inventory_location.manage'),
    ('WAREHOUSE_MANAGER', 'inventory_warehouse.manage'), ('WAREHOUSE_MANAGER', 'inventory_reports.read'), ('WAREHOUSE_MANAGER', 'inventory_reservation.create'),
    ('WAREHOUSE_MANAGER', 'inventory_reservation.release'), ('WAREHOUSE_MANAGER', 'inventory_transfer.create'), ('WAREHOUSE_MANAGER', 'inventory_reconciliation.run'),
    ('WAREHOUSE_MANAGER', 'purchase_receipt.create'), ('WAREHOUSE_MANAGER', 'purchases.read'), ('WAREHOUSE_MANAGER', 'products.read'), ('WAREHOUSE_MANAGER', 'sales_orders.read'),
    ('WAREHOUSE_MANAGER', 'manufacturing.read'), ('WAREHOUSE_MANAGER', 'production_material.issue'), ('WAREHOUSE_MANAGER', 'production_output.receive'),
    ('WAREHOUSE_MANAGER', 'outsourcing.read'), ('WAREHOUSE_MANAGER', 'outsourcing_material.dispatch'), ('WAREHOUSE_MANAGER', 'outsourcing_receipt.create'),
    ('WAREHOUSE_MANAGER', 'fulfilment.read'), ('WAREHOUSE_MANAGER', 'fulfilment.pick'), ('WAREHOUSE_MANAGER', 'fulfilment.pack'), ('WAREHOUSE_MANAGER', 'fulfilment.dispatch'),
    ('WAREHOUSE_MANAGER', 'fulfilment_delivery.update'), ('WAREHOUSE_MANAGER', 'fulfilment_returns.inspect'), ('WAREHOUSE_MANAGER', 'fulfilment_returns.receive_stock'),
    ('WAREHOUSE_MANAGER', 'documents.read'), ('WAREHOUSE_MANAGER', 'documents.upload'), ('WAREHOUSE_MANAGER', 'approvals.read'),

    ('STORE_EXECUTIVE', 'dashboard.read'), ('STORE_EXECUTIVE', 'inventory.read'), ('STORE_EXECUTIVE', 'inventory.create'), ('STORE_EXECUTIVE', 'inventory.adjust'),
    ('STORE_EXECUTIVE', 'inventory_batch.read'), ('STORE_EXECUTIVE', 'inventory_count.create'), ('STORE_EXECUTIVE', 'inventory_transfer.create'),
    ('STORE_EXECUTIVE', 'inventory_alerts.acknowledge'), ('STORE_EXECUTIVE', 'purchase_receipt.create'), ('STORE_EXECUTIVE', 'production_material.issue'),
    ('STORE_EXECUTIVE', 'production_output.receive'), ('STORE_EXECUTIVE', 'fulfilment.read'), ('STORE_EXECUTIVE', 'fulfilment.pick'), ('STORE_EXECUTIVE', 'fulfilment.pack'),
    ('STORE_EXECUTIVE', 'products.read'), ('STORE_EXECUTIVE', 'documents.read'), ('STORE_EXECUTIVE', 'documents.upload'),

    ('PRODUCTION_EXECUTIVE', 'dashboard.read'), ('PRODUCTION_EXECUTIVE', 'manufacturing.read'), ('PRODUCTION_EXECUTIVE', 'production_order.create'),
    ('PRODUCTION_EXECUTIVE', 'production_order.update'), ('PRODUCTION_EXECUTIVE', 'production_material.issue'), ('PRODUCTION_EXECUTIVE', 'production_material.reserve'),
    ('PRODUCTION_EXECUTIVE', 'production_output.receive'), ('PRODUCTION_EXECUTIVE', 'production_bom.read'), ('PRODUCTION_EXECUTIVE', 'production_plan.create'),
    ('PRODUCTION_EXECUTIVE', 'production_reports.read'), ('PRODUCTION_EXECUTIVE', 'inventory.read'), ('PRODUCTION_EXECUTIVE', 'inventory_batch.read'),
    ('PRODUCTION_EXECUTIVE', 'products.read'), ('PRODUCTION_EXECUTIVE', 'sales_orders.read'), ('PRODUCTION_EXECUTIVE', 'outsourcing.read'),
    ('PRODUCTION_EXECUTIVE', 'documents.read'), ('PRODUCTION_EXECUTIVE', 'documents.upload'), ('PRODUCTION_EXECUTIVE', 'approvals.read'),

    ('QUALITY_CONTROL', 'dashboard.read'), ('QUALITY_CONTROL', 'reports.read'), ('QUALITY_CONTROL', 'manufacturing.read'), ('QUALITY_CONTROL', 'production_reports.read'),
    ('QUALITY_CONTROL', 'production_bom.read'), ('QUALITY_CONTROL', 'production_output.receive'), ('QUALITY_CONTROL', 'fulfilment.read'),
    ('QUALITY_CONTROL', 'fulfilment_returns.inspect'), ('QUALITY_CONTROL', 'inventory.read'), ('QUALITY_CONTROL', 'inventory_batch.read'),
    ('QUALITY_CONTROL', 'inventory_reports.read'), ('QUALITY_CONTROL', 'purchases.read'), ('QUALITY_CONTROL', 'products.read'), ('QUALITY_CONTROL', 'outsourcing.read'),
    ('QUALITY_CONTROL', 'documents.read'), ('QUALITY_CONTROL', 'documents.upload'), ('QUALITY_CONTROL', 'approvals.read'),

    ('DISPATCH_MANAGER', 'dashboard.read'), ('DISPATCH_MANAGER', 'reports.read'), ('DISPATCH_MANAGER', 'fulfilment.read'), ('DISPATCH_MANAGER', 'fulfilment.pick'),
    ('DISPATCH_MANAGER', 'fulfilment.pack'), ('DISPATCH_MANAGER', 'fulfilment.dispatch'), ('DISPATCH_MANAGER', 'fulfilment_delivery.update'),
    ('DISPATCH_MANAGER', 'fulfilment_reports.read'), ('DISPATCH_MANAGER', 'fulfilment_reports.export'), ('DISPATCH_MANAGER', 'fulfilment_reservations.release'),
    ('DISPATCH_MANAGER', 'fulfilment_returns.create'), ('DISPATCH_MANAGER', 'fulfilment_returns.receive_stock'), ('DISPATCH_MANAGER', 'customer_po.read'),
    ('DISPATCH_MANAGER', 'customer_po.fulfil'), ('DISPATCH_MANAGER', 'sales_orders.read'), ('DISPATCH_MANAGER', 'customers.read'), ('DISPATCH_MANAGER', 'invoices.read'),
    ('DISPATCH_MANAGER', 'inventory.read'), ('DISPATCH_MANAGER', 'inventory_batch.read'), ('DISPATCH_MANAGER', 'inventory_reservation.create'),
    ('DISPATCH_MANAGER', 'inventory_reservation.release'), ('DISPATCH_MANAGER', 'products.read'), ('DISPATCH_MANAGER', 'documents.read'),
    ('DISPATCH_MANAGER', 'documents.upload'), ('DISPATCH_MANAGER', 'approvals.read'),

    ('DISPATCH_EXECUTIVE', 'dashboard.read'), ('DISPATCH_EXECUTIVE', 'fulfilment.read'), ('DISPATCH_EXECUTIVE', 'fulfilment.pick'), ('DISPATCH_EXECUTIVE', 'fulfilment.pack'),
    ('DISPATCH_EXECUTIVE', 'fulfilment.dispatch'), ('DISPATCH_EXECUTIVE', 'fulfilment_delivery.update'), ('DISPATCH_EXECUTIVE', 'sales_orders.read'),
    ('DISPATCH_EXECUTIVE', 'inventory.read'), ('DISPATCH_EXECUTIVE', 'products.read'), ('DISPATCH_EXECUTIVE', 'documents.read'), ('DISPATCH_EXECUTIVE', 'documents.upload'),

    ('LEGAL_COMPLIANCE', 'dashboard.read'), ('LEGAL_COMPLIANCE', 'reports.read'), ('LEGAL_COMPLIANCE', 'audit_logs.read'), ('LEGAL_COMPLIANCE', 'documents.read'),
    ('LEGAL_COMPLIANCE', 'documents.upload'), ('LEGAL_COMPLIANCE', 'customers.read'), ('LEGAL_COMPLIANCE', 'suppliers.read'), ('LEGAL_COMPLIANCE', 'invoices.read'),
    ('LEGAL_COMPLIANCE', 'billing_reports.read'), ('LEGAL_COMPLIANCE', 'purchases.read'), ('LEGAL_COMPLIANCE', 'sales_orders.read'), ('LEGAL_COMPLIANCE', 'ledger.read'),
    ('LEGAL_COMPLIANCE', 'approvals.read'),

    ('HR_MANAGER', 'dashboard.read'), ('HR_MANAGER', 'documents.read'), ('HR_MANAGER', 'documents.upload'),

    ('REPORTS_VIEWER', 'dashboard.read'), ('REPORTS_VIEWER', 'reports.read'), ('REPORTS_VIEWER', 'inventory_reports.read'), ('REPORTS_VIEWER', 'production_reports.read'),
    ('REPORTS_VIEWER', 'billing_reports.read'), ('REPORTS_VIEWER', 'fulfilment_reports.read'), ('REPORTS_VIEWER', 'customer_po_shortages.read')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from matrix m
join public.roles r on r.code = m.role_code
join public.permissions p on p.code = m.permission_code
on conflict do nothing;

-- Functional category (display only; never used for access decisions).
create or replace function private.role_category(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_code in ('SUPER_ADMIN', 'ADMIN', 'MANAGEMENT_VIEWER') then 'Administration'
    when p_code in ('ACCOUNTS_MANAGER', 'ACCOUNTS_EXECUTIVE') then 'Finance & Accounts'
    when p_code in ('SALES_MANAGER', 'SALES_EXECUTIVE', 'BILLING_MANAGER') then 'Sales & Commercial'
    when p_code in ('PURCHASE_MANAGER', 'PURCHASE_EXECUTIVE') then 'Purchase & Procurement'
    when p_code in ('INVENTORY_MANAGER', 'WAREHOUSE_MANAGER', 'STORE_EXECUTIVE') then 'Inventory & Warehouse'
    when p_code in ('PRODUCTION_MANAGER', 'PRODUCTION_EXECUTIVE', 'QUALITY_CONTROL') then 'Production & Manufacturing'
    when p_code in ('DISPATCH_MANAGER', 'DISPATCH_EXECUTIVE') then 'Dispatch & Fulfilment'
    else 'Other ERP Roles' end;
$$;

-- Administrative = holds a permission that administers the company or its access.
create or replace function private.role_is_admin(p_role uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id
                 where rp.role_id = p_role and p.code in ('users.manage', 'settings.manage', 'system.reset_data', 'approvals.manage',
                                                          'billing_settings.manage', 'amazon_integration.manage'));
$$;

-- Role check for a given user (not only the caller): used by service-role steps.
create or replace function private.actor_has_role(p_user uuid, p_company uuid, p_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
                 join public.profiles p on p.id = ur.user_id and p.company_id = ur.company_id and p.is_active
                 where ur.user_id = p_user and ur.company_id = p_company and r.code = p_code);
$$;

create or replace function private.actor_has_permission(p_user uuid, p_company uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.user_roles ur join public.role_permissions rp on rp.role_id = ur.role_id
                 join public.permissions pm on pm.id = rp.permission_id and pm.code = p_permission
                 join public.profiles p on p.id = ur.user_id and p.company_id = ur.company_id and p.is_active
                 join public.companies c on c.id = ur.company_id and c.is_active
                 where ur.user_id = p_user and ur.company_id = p_company);
$$;

-- Null when p_actor (an active users.manage holder of p_company) may assign every role; else the reason.
create or replace function private.role_assignment_problem(p_company uuid, p_actor uuid, p_roles uuid[])
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_super boolean;
  v_bad   text;
begin
  if p_actor is null or not private.actor_has_permission(p_actor, p_company, 'users.manage') then
    return 'You are not allowed to invite users or assign roles in this company.';
  end if;
  if p_roles is null or cardinality(p_roles) = 0 then
    return 'Select at least one role.';
  end if;
  if exists (select 1 from unnest(p_roles) x where x is null or not exists (select 1 from public.roles r where r.id = x)) then
    return 'One of the selected roles does not exist.';
  end if;
  v_super := private.actor_has_role(p_actor, p_company, 'SUPER_ADMIN');
  if not v_super then
    select string_agg(r.name, ', ' order by r.name) into v_bad from public.roles r
    where r.id = any (p_roles) and (r.code = 'SUPER_ADMIN' or private.role_is_admin(r.id));
    if v_bad is not null then
      return format('Only a Super Admin can assign administrative roles (%s).', v_bad);
    end if;
  end if;
  return null;
end;
$$;

revoke all on function private.role_category(text) from public, anon, authenticated;
revoke all on function private.role_is_admin(uuid) from public, anon;
grant execute on function private.role_is_admin(uuid) to authenticated;
revoke all on function private.actor_has_role(uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.actor_has_permission(uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.role_assignment_problem(uuid, uuid, uuid[]) from public, anon, authenticated;

-- Direct role edits (Users page) follow the same rule as invitations.
drop policy if exists user_roles_insert_company_admin on public.user_roles;
create policy user_roles_insert_company_admin on public.user_roles
  for insert to authenticated
  with check (
    private.has_permission(company_id, 'users.manage')
    and user_id <> auth.uid()
    and assigned_by = auth.uid()
    and (private.role_code(role_id) <> 'SUPER_ADMIN' or private.has_role(company_id, 'SUPER_ADMIN'))
    and (not private.role_is_admin(role_id) or private.has_role(company_id, 'SUPER_ADMIN'))
  );

-- -----------------------------------------------------------------------------
-- 2. Invitations
-- -----------------------------------------------------------------------------
create table if not exists public.user_invitations (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete restrict,
  email                text not null check (email = lower(btrim(email)) and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' and length(email) <= 320),
  full_name            text not null check (length(btrim(full_name)) between 1 and 120),
  employee_id          text check (employee_id is null or length(employee_id) between 1 and 50),
  department           text check (department is null or length(department) between 1 and 100),
  designation          text check (designation is null or length(designation) between 1 and 100),
  reporting_manager_id uuid references public.profiles (id) on delete set null,
  role_ids             uuid[] not null check (cardinality(role_ids) between 1 and 20),
  status               text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED', 'FAILED')),
  email_status         text not null default 'SENDING' check (email_status in ('SENDING', 'SENT', 'FAILED')),
  email_error          text check (email_error is null or length(email_error) <= 300),
  delivery_method      text check (delivery_method is null or delivery_method in ('AUTH_INVITE', 'PASSWORD_LINK')),
  auth_user_id         uuid,
  invited_by           uuid not null references public.profiles (id) on delete restrict,
  invited_at           timestamptz not null default now(),
  expires_at           timestamptz not null,
  last_sent_by         uuid references public.profiles (id) on delete set null,
  last_sent_at         timestamptz,
  send_count           int not null default 0,
  accepted_at          timestamptz,
  revoked_at           timestamptz,
  revoked_by           uuid references public.profiles (id) on delete set null,
  revoke_reason        text check (revoke_reason is null or length(revoke_reason) <= 500),
  idempotency_key      uuid not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint user_invitations_key_unique unique (company_id, idempotency_key)
);

comment on table public.user_invitations is
  'Staff invitations. The secure link is issued and verified by Supabase Auth; no token is stored here. One PENDING invitation per company and e-mail.';

create unique index if not exists user_invitations_one_pending on public.user_invitations (company_id, email) where status = 'PENDING';
create index if not exists user_invitations_company_idx on public.user_invitations (company_id, invited_at desc);
create index if not exists user_invitations_auth_user_idx on public.user_invitations (auth_user_id) where auth_user_id is not null;

drop trigger if exists user_invitations_set_updated_at on public.user_invitations;
create trigger user_invitations_set_updated_at before update on public.user_invitations
  for each row execute function private.set_updated_at();

alter table public.user_invitations enable row level security;
revoke all on public.user_invitations from anon, authenticated;
grant select on public.user_invitations to authenticated;
drop policy if exists user_invitations_select_admin on public.user_invitations;
create policy user_invitations_select_admin on public.user_invitations for select to authenticated
  using (private.has_permission(company_id, 'users.manage'));

-- Kept by the ERP reset and the force reset (user administration, not business data).
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
    ('user_invitations', 'User invitations', true),
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
    ('user_invitations', 'User invitations', true, 'User administration record (invitations and their status).'),
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

-- -----------------------------------------------------------------------------
-- 3. Role catalogue for the invitation screen (read-only)
-- -----------------------------------------------------------------------------
create or replace function public.invite_role_catalog()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('users.manage');
  v_super   boolean := private.has_role(v_company, 'SUPER_ADMIN');
begin
  return jsonb_build_object('is_super_admin', v_super, 'roles', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'code', r.code, 'name', r.name, 'description', r.description,
      'category', private.role_category(r.code), 'is_admin', r.code = 'SUPER_ADMIN' or private.role_is_admin(r.id),
      'assignable', v_super or not (r.code = 'SUPER_ADMIN' or private.role_is_admin(r.id)),
      'modules', (select coalesce(jsonb_agg(distinct split_part(p.code, '.', 1) order by split_part(p.code, '.', 1)), '[]'::jsonb)
                  from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = r.id),
      'permissions', (select coalesce(jsonb_agg(jsonb_build_object('code', p.code, 'description', p.description) order by p.code), '[]'::jsonb)
                      from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = r.id))
      order by private.role_category(r.code), r.name)
    from public.roles r), '[]'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Invitation workflow
-- -----------------------------------------------------------------------------
-- Called by the invite-user Edge Function WITH THE CALLER'S JWT (auth.uid() = inviter).
-- p_mode INVITE: records a new invitation; RESEND: renews p_invitation_id.
-- Returns what the function needs to send the e-mail; never sends anything itself.
create or replace function public.user_invitation_prepare(
  p_email           text,
  p_full_name       text,
  p_details         jsonb,
  p_role_ids        uuid[],
  p_idempotency_key uuid,
  p_mode            text default 'INVITE',
  p_invitation_id   uuid default null,
  p_expires_hours   int default 24)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := auth.uid();
  v_company  uuid;
  v_co       public.companies;
  v_inv      public.user_invitations;
  v_email    text := lower(btrim(coalesce(p_email, '')));
  v_name     text := btrim(coalesce(p_full_name, ''));
  d          jsonb := coalesce(p_details, '{}'::jsonb);
  v_problem  text;
  v_profile  public.profiles;
  v_auth     record;
  v_manager  uuid;
  v_hours    int := least(greatest(coalesce(p_expires_hours, 24), 1), 168);
  v_recent   int;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  select company_id into v_company from public.profiles where id = v_actor and is_active;
  select * into v_co from public.companies where id = v_company and is_active;
  if v_company is null or v_co.id is null or not private.actor_has_permission(v_actor, v_company, 'users.manage') then
    raise exception 'You are not allowed to invite users.' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'A request id (idempotency key) is required.' using errcode = 'P0001';
  end if;

  if coalesce(p_mode, 'INVITE') = 'RESEND' then
    select * into v_inv from public.user_invitations where id = p_invitation_id and company_id = v_company for update;
    if not found then
      raise exception 'Invitation not found in your company.' using errcode = 'P0001';
    end if;
    if v_inv.status in ('ACCEPTED', 'REVOKED') then
      raise exception 'This invitation is %; it cannot be resent.', lower(v_inv.status) using errcode = 'P0001';
    end if;
    v_problem := private.role_assignment_problem(v_company, v_actor, v_inv.role_ids);
    if v_problem is not null then
      raise exception '%', v_problem using errcode = '42501';
    end if;
    select count(*) into v_recent from public.user_invitations
      where company_id = v_company and last_sent_by = v_actor and last_sent_at > now() - interval '1 hour';
    if v_recent >= 30 then
      raise exception 'Too many invitations sent in the last hour. Try again later.' using errcode = 'P0001';
    end if;
    select u.id, u.last_sign_in_at into v_auth from auth.users u where u.id = v_inv.auth_user_id;
    if v_auth.id is not null and v_auth.last_sign_in_at is not null then
      raise exception 'This person has already signed in; the invitation cannot be resent. Ask them to use "Forgot password".' using errcode = 'P0001';
    end if;
    update public.user_invitations set status = 'PENDING', email_status = 'SENDING', email_error = null,
      expires_at = now() + make_interval(hours => v_hours), last_sent_by = v_actor, auth_user_id = null
    where id = v_inv.id returning * into v_inv;
    return jsonb_build_object('invitation_id', v_inv.id, 'mode', 'RESEND', 'email', v_inv.email, 'full_name', v_inv.full_name,
      'company_id', v_company, 'company_name', coalesce(v_co.display_name, v_co.legal_name), 'support_email', v_co.email,
      'roles', (select jsonb_agg(r.name order by r.name) from public.roles r where r.id = any (v_inv.role_ids)),
      'expires_at', v_inv.expires_at, 'replace_auth_user_id', v_auth.id, 'existing_account', false, 'needs_send', true, 'duplicate', false);
  end if;

  -- Same request again (retry): the stored invitation.
  select * into v_inv from public.user_invitations where company_id = v_company and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('invitation_id', v_inv.id, 'mode', 'INVITE', 'email', v_inv.email, 'full_name', v_inv.full_name,
      'company_id', v_company, 'company_name', coalesce(v_co.display_name, v_co.legal_name), 'support_email', v_co.email,
      'roles', (select jsonb_agg(r.name order by r.name) from public.roles r where r.id = any (v_inv.role_ids)),
      'expires_at', v_inv.expires_at, 'status', v_inv.status, 'email_status', v_inv.email_status, 'existing_account', false,
      'needs_send', v_inv.status = 'PENDING' and v_inv.auth_user_id is null, 'duplicate', true);
  end if;

  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or length(v_email) > 320 then
    raise exception 'Enter a valid work e-mail address.' using errcode = 'P0001';
  end if;
  if length(v_name) not between 1 and 120 then
    raise exception 'Enter the full name (1 to 120 characters).' using errcode = 'P0001';
  end if;
  v_problem := private.role_assignment_problem(v_company, v_actor, p_role_ids);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = case when v_problem like 'Select%' or v_problem like 'One of%' then 'P0001' else '42501' end;
  end if;
  v_manager := nullif(d ->> 'reporting_manager_id', '')::uuid;
  if v_manager is not null and not exists (select 1 from public.profiles where id = v_manager and company_id = v_company and is_active) then
    raise exception 'The reporting manager must be an active user of your company.' using errcode = 'P0001';
  end if;
  if length(coalesce(d ->> 'employee_id', '')) > 50 or length(coalesce(d ->> 'department', '')) > 100 or length(coalesce(d ->> 'designation', '')) > 100 then
    raise exception 'Employee ID is limited to 50 characters, department and designation to 100.' using errcode = 'P0001';
  end if;

  -- Existing people with this e-mail.
  select * into v_profile from public.profiles where lower(email) = v_email;
  if v_profile.id is not null and v_profile.company_id is not null and v_profile.company_id <> v_company then
    raise exception 'This e-mail belongs to a user of another company. It cannot be invited here.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.user_invitations where company_id = v_company and email = v_email and status = 'PENDING') then
    raise exception 'A pending invitation for % already exists. Resend it instead of inviting again.', v_email using errcode = '23505';
  end if;
  if v_profile.id is not null and v_profile.company_id = v_company and (v_profile.is_active or exists (select 1 from public.user_roles where user_id = v_profile.id)) then
    raise exception '% is already a user of your company. Edit their roles on the Users tab.', v_email using errcode = '23505';
  end if;

  select count(*) into v_recent from public.user_invitations where company_id = v_company and invited_by = v_actor and invited_at > now() - interval '1 hour';
  if v_recent >= 30 then
    raise exception 'Too many invitations sent in the last hour. Try again later.' using errcode = 'P0001';
  end if;

  select u.id, u.last_sign_in_at into v_auth from auth.users u where lower(u.email) = v_email;
  insert into public.user_invitations (company_id, email, full_name, employee_id, department, designation, reporting_manager_id, role_ids,
    status, email_status, invited_by, expires_at, last_sent_by, idempotency_key)
  values (v_company, v_email, v_name, nullif(btrim(d ->> 'employee_id'), ''), nullif(btrim(d ->> 'department'), ''), nullif(btrim(d ->> 'designation'), ''),
    v_manager, (select array_agg(distinct x) from unnest(p_role_ids) x), 'PENDING', 'SENDING', v_actor, now() + make_interval(hours => v_hours), v_actor, p_idempotency_key)
  returning * into v_inv;

  return jsonb_build_object('invitation_id', v_inv.id, 'mode', 'INVITE', 'email', v_inv.email, 'full_name', v_inv.full_name,
    'company_id', v_company, 'company_name', coalesce(v_co.display_name, v_co.legal_name), 'support_email', v_co.email,
    'roles', (select jsonb_agg(r.name order by r.name) from public.roles r where r.id = any (v_inv.role_ids)), 'expires_at', v_inv.expires_at,
    -- Never-signed-in Auth user without a company (an earlier unfinished invitation): replaced, so one account remains.
    'replace_auth_user_id', case when v_auth.id is not null and v_auth.last_sign_in_at is null then v_auth.id end,
    -- Account that has signed in before (no company yet): attached, and sent a password link instead of an invitation.
    'existing_account', v_auth.id is not null and v_auth.last_sign_in_at is not null,
    'existing_auth_user_id', case when v_auth.id is not null and v_auth.last_sign_in_at is not null then v_auth.id end,
    'needs_send', true, 'duplicate', false);
end;
$$;

-- service_role (invite-user): the e-mail was sent; attach the Auth user, assign roles (inactive until accepted).
create or replace function public.user_invitation_finalize(p_invitation_id uuid, p_auth_user_id uuid, p_delivery_method text default 'AUTH_INVITE')
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv     public.user_invitations;
  v_profile public.profiles;
  v_problem text;
  v_actor   uuid;
begin
  select * into v_inv from public.user_invitations where id = p_invitation_id for update;
  if not found or v_inv.status <> 'PENDING' then
    raise exception 'The invitation is not pending.' using errcode = 'P0001';
  end if;
  v_actor := coalesce(v_inv.last_sent_by, v_inv.invited_by);
  v_problem := private.role_assignment_problem(v_inv.company_id, v_actor, v_inv.role_ids);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '42501';
  end if;
  select * into v_profile from public.profiles where id = p_auth_user_id for update;
  if not found or lower(v_profile.email) <> v_inv.email then
    raise exception 'The invited account does not match the invitation.' using errcode = 'P0001';
  end if;
  if v_profile.company_id is not null and v_profile.company_id <> v_inv.company_id then
    raise exception 'This account belongs to another company.' using errcode = 'P0001';
  end if;
  update public.profiles set company_id = v_inv.company_id, full_name = coalesce(full_name, v_inv.full_name), is_active = false
  where id = p_auth_user_id and (company_id is null or company_id = v_inv.company_id) and not is_active;
  if not found then
    raise exception 'This account is already active.' using errcode = 'P0001';
  end if;
  insert into public.user_roles (user_id, company_id, role_id, assigned_by)
  select p_auth_user_id, v_inv.company_id, r, v_actor from unnest(v_inv.role_ids) r
  on conflict (user_id, company_id, role_id) do nothing;
  update public.user_invitations set auth_user_id = p_auth_user_id, email_status = 'SENT', email_error = null,
    delivery_method = coalesce(p_delivery_method, 'AUTH_INVITE'), last_sent_at = now(), send_count = send_count + 1
  where id = v_inv.id returning * into v_inv;
  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_inv.company_id, v_actor, case when v_inv.send_count > 1 then 'user.invitation_resent' else 'user.invited' end, 'user_invitation', v_inv.id::text,
    jsonb_build_object('email', v_inv.email, 'auth_user_id', p_auth_user_id, 'roles', (select jsonb_agg(code order by code) from public.roles where id = any (v_inv.role_ids)),
      'expires_at', v_inv.expires_at, 'delivery_method', v_inv.delivery_method, 'send_count', v_inv.send_count));
  return jsonb_build_object('invitation_id', v_inv.id, 'status', v_inv.status, 'email_status', v_inv.email_status, 'auth_user_id', p_auth_user_id,
    'expires_at', v_inv.expires_at, 'send_count', v_inv.send_count);
end;
$$;

-- service_role (invite-user): the e-mail or provisioning failed; nothing stays assigned.
create or replace function public.user_invitation_fail(p_invitation_id uuid, p_error text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv public.user_invitations;
begin
  update public.user_invitations set status = 'FAILED', email_status = 'FAILED', email_error = left(coalesce(p_error, 'unknown error'), 300), auth_user_id = null
  where id = p_invitation_id and status = 'PENDING' returning * into v_inv;
  if not found then return jsonb_build_object('updated', false); end if;
  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_inv.company_id, coalesce(v_inv.last_sent_by, v_inv.invited_by), 'user.invitation_failed', 'user_invitation', v_inv.id::text,
    jsonb_build_object('email', v_inv.email, 'error', v_inv.email_error));
  return jsonb_build_object('updated', true, 'invitation_id', v_inv.id, 'status', v_inv.status);
end;
$$;

-- users.manage: revoke a pending / failed / expired invitation. Roles of the never-activated
-- account are removed and it is detached from the company; the Edge Function then deletes
-- the Auth user if it never signed in (so the link stops working).
create or replace function public.user_invitation_revoke(p_invitation_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('users.manage');
  v_inv     public.user_invitations;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_signed  timestamptz;
begin
  select * into v_inv from public.user_invitations where id = p_invitation_id and company_id = v_company for update;
  if not found then
    raise exception 'Invitation not found in your company.' using errcode = 'P0001';
  end if;
  if v_inv.status in ('ACCEPTED', 'REVOKED') then
    raise exception 'This invitation is already %. Deactivate the user on the Users tab instead.', lower(v_inv.status) using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception 'Give a reason (3 to 500 characters).' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.roles r where r.id = any (v_inv.role_ids) and (r.code = 'SUPER_ADMIN' or private.role_is_admin(r.id)))
     and not private.has_role(v_company, 'SUPER_ADMIN') then
    raise exception 'Only a Super Admin can revoke an invitation with administrative roles.' using errcode = '42501';
  end if;
  if v_inv.auth_user_id is not null then
    delete from public.user_roles where user_id = v_inv.auth_user_id and company_id = v_company
      and exists (select 1 from public.profiles p where p.id = v_inv.auth_user_id and not p.is_active);
    update public.profiles set company_id = null where id = v_inv.auth_user_id and company_id = v_company and not is_active;
    select last_sign_in_at into v_signed from auth.users where id = v_inv.auth_user_id;
  end if;
  update public.user_invitations set status = 'REVOKED', revoked_at = now(), revoked_by = auth.uid(), revoke_reason = v_reason
  where id = v_inv.id returning * into v_inv;
  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_company, auth.uid(), 'user.invitation_revoked', 'user_invitation', v_inv.id::text, jsonb_build_object('email', v_inv.email, 'reason', v_reason));
  return jsonb_build_object('invitation_id', v_inv.id, 'status', v_inv.status, 'auth_user_id', v_inv.auth_user_id,
    'delete_auth_user', v_inv.auth_user_id is not null and v_signed is null);
end;
$$;

-- The signed-in invitee's pending invitation (onboarding page). Works before activation.
create or replace function public.my_invitation()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_inv public.user_invitations;
  v_co  public.companies;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  select * into v_inv from public.user_invitations where auth_user_id = auth.uid() order by invited_at desc limit 1;
  if not found then return null; end if;
  select * into v_co from public.companies where id = v_inv.company_id;
  return jsonb_build_object('invitation_id', v_inv.id, 'company_name', coalesce(v_co.display_name, v_co.legal_name), 'full_name', v_inv.full_name,
    'email', v_inv.email, 'roles', (select jsonb_agg(r.name order by r.name) from public.roles r where r.id = any (v_inv.role_ids)),
    'status', case when v_inv.status = 'PENDING' and v_inv.expires_at < now() then 'EXPIRED' else v_inv.status end,
    'expires_at', v_inv.expires_at, 'support_email', v_co.email);
end;
$$;

-- The invitee activates their account (after setting a password). Company and roles come
-- only from the invitation; nothing the browser sends is used.
create or replace function public.user_invitation_accept()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_inv  public.user_invitations;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  select * into v_inv from public.user_invitations where auth_user_id = v_user order by invited_at desc limit 1 for update;
  if not found then
    raise exception 'No invitation was found for this account.' using errcode = 'P0001';
  end if;
  if v_inv.status = 'ACCEPTED' then
    return jsonb_build_object('invitation_id', v_inv.id, 'status', 'ACCEPTED', 'already_accepted', true);
  end if;
  if v_inv.status = 'REVOKED' then
    raise exception 'This invitation was revoked. Contact your administrator.' using errcode = 'P0001';
  end if;
  if v_inv.status <> 'PENDING' then
    raise exception 'This invitation is no longer valid. Ask your administrator to resend it.' using errcode = 'P0001';
  end if;
  if v_inv.expires_at < now() then
    update public.user_invitations set status = 'EXPIRED' where id = v_inv.id;
    insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (v_inv.company_id, v_user, 'user.invitation_expired', 'user_invitation', v_inv.id::text, jsonb_build_object('email', v_inv.email));
    return jsonb_build_object('invitation_id', v_inv.id, 'status', 'EXPIRED', 'error', 'This invitation has expired. Ask your administrator to resend it.');
  end if;
  update public.profiles set is_active = true where id = v_user and company_id = v_inv.company_id;
  if not found then
    raise exception 'The account is not linked to the inviting company. Contact your administrator.' using errcode = 'P0001';
  end if;
  update public.user_invitations set status = 'ACCEPTED', accepted_at = now() where id = v_inv.id returning * into v_inv;
  insert into public.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_inv.company_id, v_user, 'user.invitation_accepted', 'user_invitation', v_inv.id::text,
    jsonb_build_object('email', v_inv.email, 'roles', (select jsonb_agg(r.code order by r.code) from public.roles r
      join public.user_roles ur on ur.role_id = r.id and ur.user_id = v_user and ur.company_id = v_inv.company_id)));
  perform private.notify(v_inv.company_id, v_inv.invited_by, 'USER_ACTIVATED', 'Invitation accepted',
    format('%s (%s) accepted the invitation and activated their account.', v_inv.full_name, v_inv.email), 'INFO',
    'USER_INVITATION', v_inv.id::text, '/users?tab=invitations', 'USER_ACTIVATED:' || v_inv.id::text);
  return jsonb_build_object('invitation_id', v_inv.id, 'status', 'ACCEPTED', 'company_id', v_inv.company_id,
    'roles', (select jsonb_agg(r.name order by r.name) from public.roles r join public.user_roles ur on ur.role_id = r.id
              and ur.user_id = v_user and ur.company_id = v_inv.company_id));
end;
$$;

create or replace function public.user_invitations_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('users.manage');
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', i.id, 'email', i.email, 'full_name', i.full_name, 'employee_id', i.employee_id, 'department', i.department, 'designation', i.designation,
      'reporting_manager', (select coalesce(p.full_name, p.email) from public.profiles p where p.id = i.reporting_manager_id),
      'roles', (select jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'name', r.name) order by r.name) from public.roles r where r.id = any (i.role_ids)),
      'status', case when i.status = 'PENDING' and i.expires_at < now() then 'EXPIRED' else i.status end,
      'email_status', i.email_status, 'email_error', i.email_error, 'delivery_method', i.delivery_method,
      'invited_at', i.invited_at, 'invited_by', private.user_label(i.invited_by), 'expires_at', i.expires_at,
      'last_sent_at', i.last_sent_at, 'send_count', i.send_count, 'accepted_at', i.accepted_at,
      'revoked_at', i.revoked_at, 'revoked_by', case when i.revoked_by is null then null else private.user_label(i.revoked_by) end, 'revoke_reason', i.revoke_reason,
      'user_id', case when i.status = 'ACCEPTED' then i.auth_user_id end) order by i.invited_at desc)
    from public.user_invitations i where i.company_id = v_company), '[]'::jsonb);
end;
$$;

revoke all on function public.invite_role_catalog() from public, anon;
revoke all on function public.user_invitation_prepare(text, text, jsonb, uuid[], uuid, text, uuid, int) from public, anon;
revoke all on function public.user_invitation_finalize(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.user_invitation_fail(uuid, text) from public, anon, authenticated;
revoke all on function public.user_invitation_revoke(uuid, text) from public, anon;
revoke all on function public.my_invitation() from public, anon;
revoke all on function public.user_invitation_accept() from public, anon;
revoke all on function public.user_invitations_list() from public, anon;
grant execute on function public.invite_role_catalog() to authenticated;
grant execute on function public.user_invitation_prepare(text, text, jsonb, uuid[], uuid, text, uuid, int) to authenticated;
grant execute on function public.user_invitation_finalize(uuid, uuid, text) to service_role;
grant execute on function public.user_invitation_fail(uuid, text) to service_role;
grant execute on function public.user_invitation_revoke(uuid, text) to authenticated;
grant execute on function public.my_invitation() to authenticated;
grant execute on function public.user_invitation_accept() to authenticated;
grant execute on function public.user_invitations_list() to authenticated;

notify pgrst, 'reload schema';
