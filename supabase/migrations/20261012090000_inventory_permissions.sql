-- =============================================================================
-- Phase 4: inventory permissions
--
-- Reused from Phase 2 (equivalent meaning, not duplicated):
--   inventory.read                -> view inventory
--   inventory.create              -> post receipts, issues, customer/supplier returns
--   inventory.adjust              -> request stock adjustments
--   inventory.approve_adjustment  -> approve adjustments and post reversals
-- New (codes are resource.action; the brief's three-part names are mapped
-- to a resource prefix, e.g. inventory.opening_stock.create -> inventory_opening.create):
-- =============================================================================

insert into public.permissions (resource, action, description) values
  ('inventory_opening',        'create',      'Submit opening stock (manual or import)'),
  ('inventory_opening',        'approve',     'Approve and post opening stock'),
  ('inventory_transfer',       'create',      'Transfer stock between locations'),
  ('inventory_count',          'create',      'Create physical stock counts and record quantities'),
  ('inventory_count',          'approve',     'Approve stock count variances'),
  ('inventory_reservation',    'create',      'Reserve stock'),
  ('inventory_reservation',    'release',     'Release or cancel stock reservations'),
  ('inventory_reports',        'read',        'View inventory reports, valuation and historical stock'),
  ('inventory',                'export',      'Export inventory data'),
  ('inventory_warehouse',      'manage',      'Create and edit warehouses'),
  ('inventory_location',       'manage',      'Create and edit storage locations'),
  ('inventory_batch',          'read',        'View batch / lot tracking'),
  ('inventory_reconciliation', 'run',         'Run ledger-to-balance reconciliation'),
  ('inventory_alerts',         'acknowledge', 'Acknowledge inventory alerts')
on conflict (code) do nothing;

with matrix (role_code, permission_code) as (
  values
    -- ADMIN: oversight, approvals and master data for storage (no direct stock postings)
    ('ADMIN', 'inventory_opening.approve'), ('ADMIN', 'inventory.approve_adjustment'), ('ADMIN', 'inventory_count.approve'),
    ('ADMIN', 'inventory_reports.read'), ('ADMIN', 'inventory.export'), ('ADMIN', 'inventory_batch.read'),
    ('ADMIN', 'inventory_warehouse.manage'), ('ADMIN', 'inventory_location.manage'),
    ('ADMIN', 'inventory_reconciliation.run'), ('ADMIN', 'inventory_alerts.acknowledge'),

    -- INVENTORY_MANAGER: full operational inventory control (cannot approve own requests: see SoD)
    ('INVENTORY_MANAGER', 'inventory_opening.create'), ('INVENTORY_MANAGER', 'inventory_opening.approve'),
    ('INVENTORY_MANAGER', 'inventory_transfer.create'), ('INVENTORY_MANAGER', 'inventory_count.create'),
    ('INVENTORY_MANAGER', 'inventory_count.approve'), ('INVENTORY_MANAGER', 'inventory_reservation.create'),
    ('INVENTORY_MANAGER', 'inventory_reservation.release'), ('INVENTORY_MANAGER', 'inventory_reports.read'),
    ('INVENTORY_MANAGER', 'inventory.export'), ('INVENTORY_MANAGER', 'inventory_warehouse.manage'),
    ('INVENTORY_MANAGER', 'inventory_location.manage'), ('INVENTORY_MANAGER', 'inventory_batch.read'),
    ('INVENTORY_MANAGER', 'inventory_reconciliation.run'), ('INVENTORY_MANAGER', 'inventory_alerts.acknowledge'),

    ('PRODUCTION_MANAGER', 'inventory_batch.read'), ('PRODUCTION_MANAGER', 'inventory_reports.read'),
    ('PRODUCTION_MANAGER', 'inventory_alerts.acknowledge'),

    ('PURCHASE_MANAGER', 'inventory_batch.read'), ('PURCHASE_MANAGER', 'inventory_reports.read'),
    ('PURCHASE_MANAGER', 'inventory_alerts.acknowledge'),

    ('SALES_MANAGER', 'inventory_reservation.create'), ('SALES_MANAGER', 'inventory_reservation.release'),
    ('SALES_MANAGER', 'inventory_reports.read'), ('SALES_MANAGER', 'inventory.export'),

    ('ACCOUNTS_MANAGER', 'inventory.read'), ('ACCOUNTS_MANAGER', 'inventory_reports.read'), ('ACCOUNTS_MANAGER', 'inventory.export'),

    ('MANAGEMENT_VIEWER', 'inventory_reports.read'), ('MANAGEMENT_VIEWER', 'inventory_batch.read')
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
