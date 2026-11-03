-- =============================================================================
-- Phase 7: sales order and fulfilment permissions
--
-- Permission codes are resource.action (one dot), so the brief's three-part
-- codes map as follows:
--   sales_orders.read                     -> sales_orders.read (Phase 2, reused)
--   sales_orders.create/confirm/update/cancel -> new
--   fulfilment.read/pick/pack/dispatch    -> new
--   fulfilment.delivery.update            -> fulfilment_delivery.update
--   fulfilment.return.create/inspect/approve/receive_stock
--                                         -> fulfilment_returns.create / .inspect / .approve / .receive_stock
--   fulfilment.reservation.release        -> fulfilment_reservations.release
--   fulfilment.reports.read / .export     -> fulfilment_reports.read / .export
-- Reused: customer_po.allocate (Phase 6) also allocates stock to sales order
-- lines; customers.read; inventory.read.
-- Phase 2's sales_orders.manage is no longer checked (superseded by the
-- granular permissions above); it is kept so existing grants stay valid.
-- =============================================================================

insert into public.permissions (resource, action, description) values
  ('sales_orders',            'create',        'Create sales orders from customer POs or manually'),
  ('sales_orders',            'confirm',       'Confirm sales orders'),
  ('sales_orders',            'update',        'Edit sales orders, hold/resume and record backorder and quantity changes'),
  ('sales_orders',            'cancel',        'Cancel sales orders (releases their remaining reservations)'),
  ('fulfilment',              'read',          'View fulfilments, picking, packing, dispatch and delivery'),
  ('fulfilment',              'pick',          'Create pick lists and record picking'),
  ('fulfilment',              'pack',          'Record packing and mark fulfilments ready for dispatch'),
  ('fulfilment',              'dispatch',      'Post dispatches (stock issue) for packed fulfilments'),
  ('fulfilment_delivery',     'update',        'Record delivery events'),
  ('fulfilment_returns',      'create',        'Record customer return requests'),
  ('fulfilment_returns',      'inspect',       'Inspect returned goods and record dispositions'),
  ('fulfilment_returns',      'approve',       'Authorise or reject customer returns'),
  ('fulfilment_returns',      'receive_stock', 'Receive returned goods into quarantine and post return dispositions'),
  ('fulfilment_reservations', 'release',       'Release stock reserved for sales order lines'),
  ('fulfilment_reports',      'read',          'View fulfilment reports and the sales overview'),
  ('fulfilment_reports',      'export',        'Export fulfilment reports')
on conflict (code) do nothing;

with matrix (role_code, permission_code) as (
  values
    ('SALES_MANAGER', 'sales_orders.create'), ('SALES_MANAGER', 'sales_orders.confirm'), ('SALES_MANAGER', 'sales_orders.update'),
    ('SALES_MANAGER', 'sales_orders.cancel'), ('SALES_MANAGER', 'fulfilment.read'), ('SALES_MANAGER', 'fulfilment_delivery.update'),
    ('SALES_MANAGER', 'fulfilment_returns.create'), ('SALES_MANAGER', 'fulfilment_returns.approve'),
    ('SALES_MANAGER', 'fulfilment_reservations.release'), ('SALES_MANAGER', 'fulfilment_reports.read'), ('SALES_MANAGER', 'fulfilment_reports.export'),

    ('INVENTORY_MANAGER', 'fulfilment.read'), ('INVENTORY_MANAGER', 'fulfilment.pick'), ('INVENTORY_MANAGER', 'fulfilment.pack'),
    ('INVENTORY_MANAGER', 'fulfilment.dispatch'), ('INVENTORY_MANAGER', 'fulfilment_delivery.update'),
    ('INVENTORY_MANAGER', 'fulfilment_returns.create'), ('INVENTORY_MANAGER', 'fulfilment_returns.inspect'),
    ('INVENTORY_MANAGER', 'fulfilment_returns.receive_stock'), ('INVENTORY_MANAGER', 'fulfilment_reservations.release'),
    ('INVENTORY_MANAGER', 'fulfilment_reports.read'), ('INVENTORY_MANAGER', 'fulfilment_reports.export'),

    ('ADMIN', 'sales_orders.cancel'), ('ADMIN', 'fulfilment.read'), ('ADMIN', 'fulfilment_returns.approve'),
    ('ADMIN', 'fulfilment_reports.read'), ('ADMIN', 'fulfilment_reports.export'),

    ('PRODUCTION_MANAGER', 'fulfilment.read'), ('PRODUCTION_MANAGER', 'fulfilment_reports.read'),
    ('ACCOUNTS_MANAGER', 'fulfilment.read'), ('ACCOUNTS_MANAGER', 'fulfilment_reports.read'), ('ACCOUNTS_MANAGER', 'fulfilment_reports.export'),
    ('MANAGEMENT_VIEWER', 'fulfilment.read'), ('MANAGEMENT_VIEWER', 'fulfilment_reports.read')
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
