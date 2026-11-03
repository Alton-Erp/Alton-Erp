-- =============================================================================
-- Seed: role and permission catalogue, and the least-privilege role matrix.
-- Idempotent: re-running adds missing rows and never removes grants an
-- operator may have added. Change the matrix with a NEW migration.
-- =============================================================================

insert into public.roles (code, name, description) values
  ('SUPER_ADMIN',        'Super Admin',        'Full administration of the company, including Super Admin assignments.'),
  ('ADMIN',              'Administrator',      'Day-to-day administration: users, settings, master data and read access to all modules.'),
  ('INVENTORY_MANAGER',  'Inventory Manager',  'Stock, adjustments and product master.'),
  ('PRODUCTION_MANAGER', 'Production Manager', 'Manufacturing and production orders.'),
  ('PURCHASE_MANAGER',   'Purchase Manager',   'Suppliers, purchase orders and outsourced procurement.'),
  ('SALES_MANAGER',      'Sales Manager',      'Customers, sales orders, marketplace imports and PO uploads.'),
  ('ACCOUNTS_MANAGER',   'Accounts Manager',   'Invoices, payments and financial reporting.'),
  ('MANAGEMENT_VIEWER',  'Management Viewer',  'Read-only access to dashboards and management reports.')
on conflict (code) do nothing;

insert into public.permissions (resource, action, description) values
  ('dashboard',           'read',                 'View the dashboard'),
  ('inventory',           'read',                 'View stock levels and movements'),
  ('inventory',           'create',               'Record stock receipts and issues'),
  ('inventory',           'adjust',               'Request stock adjustments'),
  ('inventory',           'approve_adjustment',   'Approve stock adjustments'),
  ('manufacturing',       'read',                 'View production orders'),
  ('manufacturing',       'manage',               'Create and update production orders'),
  ('purchases',           'read',                 'View purchase orders and outsourced procurement'),
  ('purchases',           'manage',               'Create and update purchase orders and procurement requests'),
  ('suppliers',           'read',                 'View suppliers'),
  ('suppliers',           'manage',               'Create and update suppliers'),
  ('sales_orders',        'read',                 'View sales orders and PO uploads'),
  ('sales_orders',        'manage',               'Create and update sales orders and analyse PO uploads'),
  ('customers',           'read',                 'View customers'),
  ('customers',           'manage',               'Create and update customers'),
  ('marketplace_imports', 'read',                 'View marketplace orders'),
  ('marketplace_imports', 'manage',               'Import and update marketplace orders'),
  ('products',            'read',                 'View the product master'),
  ('products',            'manage',               'Create and update products'),
  ('invoices',            'read',                 'View invoices'),
  ('invoices',            'create',               'Create invoices'),
  ('invoices',            'approve',              'Approve invoices'),
  ('invoices',            'cancel',               'Cancel invoices'),
  ('payments',            'read',                 'View payments and receivables'),
  ('payments',            'manage',               'Record and allocate payments'),
  ('reports',             'read',                 'View reports and analytics'),
  ('users',               'manage',               'Manage users, activation and role assignments'),
  ('settings',            'manage',               'View and change company settings'),
  ('audit_logs',          'read',                 'View the audit log')
on conflict (code) do nothing;

-- Role matrix. SUPER_ADMIN receives every permission (listed explicitly below
-- via a cross join so new permissions must be granted deliberately by a new
-- migration rather than implicitly).
with matrix (role_code, permission_code) as (
  values
    -- ADMIN: administration + master data + read-only on operational/financial modules
    ('ADMIN', 'dashboard.read'), ('ADMIN', 'reports.read'),
    ('ADMIN', 'users.manage'), ('ADMIN', 'settings.manage'), ('ADMIN', 'audit_logs.read'),
    ('ADMIN', 'inventory.read'), ('ADMIN', 'manufacturing.read'), ('ADMIN', 'purchases.read'),
    ('ADMIN', 'suppliers.read'), ('ADMIN', 'suppliers.manage'),
    ('ADMIN', 'sales_orders.read'), ('ADMIN', 'customers.read'), ('ADMIN', 'customers.manage'),
    ('ADMIN', 'marketplace_imports.read'),
    ('ADMIN', 'products.read'), ('ADMIN', 'products.manage'),
    ('ADMIN', 'invoices.read'), ('ADMIN', 'payments.read'),

    ('INVENTORY_MANAGER', 'dashboard.read'), ('INVENTORY_MANAGER', 'reports.read'),
    ('INVENTORY_MANAGER', 'inventory.read'), ('INVENTORY_MANAGER', 'inventory.create'),
    ('INVENTORY_MANAGER', 'inventory.adjust'), ('INVENTORY_MANAGER', 'inventory.approve_adjustment'),
    ('INVENTORY_MANAGER', 'products.read'), ('INVENTORY_MANAGER', 'products.manage'),
    ('INVENTORY_MANAGER', 'manufacturing.read'), ('INVENTORY_MANAGER', 'purchases.read'),
    ('INVENTORY_MANAGER', 'sales_orders.read'),

    ('PRODUCTION_MANAGER', 'dashboard.read'), ('PRODUCTION_MANAGER', 'reports.read'),
    ('PRODUCTION_MANAGER', 'manufacturing.read'), ('PRODUCTION_MANAGER', 'manufacturing.manage'),
    ('PRODUCTION_MANAGER', 'inventory.read'), ('PRODUCTION_MANAGER', 'products.read'),
    ('PRODUCTION_MANAGER', 'sales_orders.read'),

    ('PURCHASE_MANAGER', 'dashboard.read'), ('PURCHASE_MANAGER', 'reports.read'),
    ('PURCHASE_MANAGER', 'purchases.read'), ('PURCHASE_MANAGER', 'purchases.manage'),
    ('PURCHASE_MANAGER', 'suppliers.read'), ('PURCHASE_MANAGER', 'suppliers.manage'),
    ('PURCHASE_MANAGER', 'inventory.read'), ('PURCHASE_MANAGER', 'products.read'),

    ('SALES_MANAGER', 'dashboard.read'), ('SALES_MANAGER', 'reports.read'),
    ('SALES_MANAGER', 'sales_orders.read'), ('SALES_MANAGER', 'sales_orders.manage'),
    ('SALES_MANAGER', 'customers.read'), ('SALES_MANAGER', 'customers.manage'),
    ('SALES_MANAGER', 'marketplace_imports.read'), ('SALES_MANAGER', 'marketplace_imports.manage'),
    ('SALES_MANAGER', 'inventory.read'), ('SALES_MANAGER', 'products.read'),
    ('SALES_MANAGER', 'invoices.read'),

    ('ACCOUNTS_MANAGER', 'dashboard.read'), ('ACCOUNTS_MANAGER', 'reports.read'),
    ('ACCOUNTS_MANAGER', 'invoices.read'), ('ACCOUNTS_MANAGER', 'invoices.create'),
    ('ACCOUNTS_MANAGER', 'invoices.approve'), ('ACCOUNTS_MANAGER', 'invoices.cancel'),
    ('ACCOUNTS_MANAGER', 'payments.read'), ('ACCOUNTS_MANAGER', 'payments.manage'),
    ('ACCOUNTS_MANAGER', 'customers.read'), ('ACCOUNTS_MANAGER', 'suppliers.read'),
    ('ACCOUNTS_MANAGER', 'sales_orders.read'), ('ACCOUNTS_MANAGER', 'purchases.read'),

    ('MANAGEMENT_VIEWER', 'dashboard.read'), ('MANAGEMENT_VIEWER', 'reports.read'),
    ('MANAGEMENT_VIEWER', 'inventory.read'), ('MANAGEMENT_VIEWER', 'manufacturing.read'),
    ('MANAGEMENT_VIEWER', 'purchases.read'), ('MANAGEMENT_VIEWER', 'sales_orders.read'),
    ('MANAGEMENT_VIEWER', 'invoices.read'), ('MANAGEMENT_VIEWER', 'payments.read')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from matrix m
join public.roles r on r.code = m.role_code
join public.permissions p on p.code = m.permission_code
on conflict do nothing;

-- SUPER_ADMIN: every permission defined so far.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'SUPER_ADMIN'
on conflict do nothing;
