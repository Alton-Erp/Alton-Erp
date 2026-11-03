-- =============================================================================
-- Phase 6: customer purchase order (PO) permissions
--
-- The brief's "purchase_orders.*" codes describe CUSTOMER purchase orders. The
-- existing purchases.* permissions are for SUPPLIER purchase orders, so the new
-- codes use the resource "customer_po" to avoid confusing the two:
--   purchase_orders.read                 -> customer_po.read
--   purchase_orders.upload / .import     -> customer_po.import (files are parsed in
--                                           the browser; "upload" stores nothing
--                                           until the import is confirmed)
--   purchase_orders.match_products       -> customer_po.match
--   purchase_orders.update               -> customer_po.update
--   purchase_orders.revise               -> customer_po.revise
--   purchase_orders.cancel               -> customer_po.cancel
--   purchase_orders.allocate             -> customer_po.allocate
--   purchase_orders.release_reservations -> customer_po.release
--   purchase_orders.shortages.read       -> customer_po_shortages.read
--   purchase_orders.reports.export       -> customer_po_reports.export
-- Added: customer_po.fulfil (record dispatch of allocated stock).
-- Reused: customers.read / customers.manage (Phase 2) for the customer master.
-- =============================================================================

insert into public.permissions (resource, action, description) values
  ('customer_po',           'read',     'View customer purchase orders, product matching and stock availability'),
  ('customer_po',           'import',   'Upload and import customer purchase orders'),
  ('customer_po',           'match',    'Match PO lines to products, review duplicates and correct lines'),
  ('customer_po',           'update',   'Edit PO details, hold/resume, refresh analysis and manage shortage follow-up'),
  ('customer_po',           'revise',   'Import a revised version of an existing customer PO'),
  ('customer_po',           'cancel',   'Cancel customer purchase orders (releases their reservations)'),
  ('customer_po',           'allocate', 'Allocate (reserve) stock to customer PO lines'),
  ('customer_po',           'release',  'Release stock reserved for customer PO lines'),
  ('customer_po',           'fulfil',   'Record dispatch of stock allocated to customer POs'),
  ('customer_po_shortages', 'read',     'View customer PO shortage analysis'),
  ('customer_po_reports',   'export',   'Export customer PO reports')
on conflict (code) do nothing;

with matrix (role_code, permission_code) as (
  values
    ('SALES_MANAGER', 'customer_po.read'), ('SALES_MANAGER', 'customer_po.import'), ('SALES_MANAGER', 'customer_po.match'),
    ('SALES_MANAGER', 'customer_po.update'), ('SALES_MANAGER', 'customer_po.revise'), ('SALES_MANAGER', 'customer_po.cancel'),
    ('SALES_MANAGER', 'customer_po.allocate'), ('SALES_MANAGER', 'customer_po.release'), ('SALES_MANAGER', 'customer_po_shortages.read'),
    ('SALES_MANAGER', 'customer_po_reports.export'),

    ('INVENTORY_MANAGER', 'customer_po.read'), ('INVENTORY_MANAGER', 'customer_po.allocate'), ('INVENTORY_MANAGER', 'customer_po.release'),
    ('INVENTORY_MANAGER', 'customer_po.fulfil'), ('INVENTORY_MANAGER', 'customer_po_shortages.read'), ('INVENTORY_MANAGER', 'customer_po_reports.export'),
    ('INVENTORY_MANAGER', 'customers.read'),

    ('ADMIN', 'customer_po.read'), ('ADMIN', 'customer_po.cancel'), ('ADMIN', 'customer_po.release'),
    ('ADMIN', 'customer_po_shortages.read'), ('ADMIN', 'customer_po_reports.export'),

    ('PRODUCTION_MANAGER', 'customer_po.read'), ('PRODUCTION_MANAGER', 'customer_po_shortages.read'),
    ('PURCHASE_MANAGER', 'customer_po.read'), ('PURCHASE_MANAGER', 'customer_po_shortages.read'),
    ('ACCOUNTS_MANAGER', 'customer_po.read'), ('ACCOUNTS_MANAGER', 'customer_po_reports.export'),
    ('MANAGEMENT_VIEWER', 'customer_po.read'), ('MANAGEMENT_VIEWER', 'customer_po_shortages.read'), ('MANAGEMENT_VIEWER', 'customers.read')
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
