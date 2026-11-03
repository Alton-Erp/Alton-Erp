-- =============================================================================
-- Supplier purchase orders and goods receipts: permissions
--
-- Reused (equivalent meaning, not duplicated):
--   purchases.read   -> view supplier purchase orders, goods receipts and history
-- purchases.manage (seed RBAC) is a coarse umbrella permission; this module
-- uses the granular permissions below and does not check it.
--
-- Codes follow the existing resource.action convention.
-- Additive and idempotent: existing grants are never removed.
-- =============================================================================

insert into public.permissions (resource, action, description) values
  ('purchase_order',     'create',  'Create supplier purchase orders, edit own drafts and submit them for approval'),
  ('purchase_order',     'update',  'Edit any draft supplier purchase order and submit it for approval'),
  ('purchase_order',     'approve', 'Approve or reject supplier purchase orders (not your own when segregation of duties is on)'),
  ('purchase_order',     'send',    'Mark approved purchase orders as sent to the supplier'),
  ('purchase_order',     'amend',   'Amend approved purchase orders (creates a new revision that needs approval again)'),
  ('purchase_order',     'cancel',  'Cancel purchase orders without receipts and short-close partially received orders'),
  ('purchase_order',     'export',  'Print and download supplier purchase orders'),
  ('purchase_receipt',   'create',  'Record goods receipts against purchase orders and post the received stock to inventory'),
  ('purchase_exception', 'approve', 'Authorise purchasing exceptions: receiving more than ordered and reversing posted goods receipts')
on conflict (code) do nothing;

with matrix (role_code, permission_code) as (
  values
    -- ADMIN: oversight, approval and exceptions (no day-to-day ordering)
    ('ADMIN', 'purchase_order.approve'), ('ADMIN', 'purchase_order.export'), ('ADMIN', 'purchase_exception.approve'),

    -- PURCHASE_MANAGER: runs purchasing end to end. Another authorised user
    -- must approve their own orders while segregation of duties is on.
    ('PURCHASE_MANAGER', 'purchase_order.create'), ('PURCHASE_MANAGER', 'purchase_order.update'),
    ('PURCHASE_MANAGER', 'purchase_order.approve'), ('PURCHASE_MANAGER', 'purchase_order.send'),
    ('PURCHASE_MANAGER', 'purchase_order.amend'), ('PURCHASE_MANAGER', 'purchase_order.cancel'),
    ('PURCHASE_MANAGER', 'purchase_order.export'), ('PURCHASE_MANAGER', 'purchase_receipt.create'),

    -- INVENTORY_MANAGER: stores side (receives goods into stock); already has purchases.read
    ('INVENTORY_MANAGER', 'purchase_receipt.create'),

    -- ACCOUNTS_MANAGER: already has purchases.read; may print / download POs
    ('ACCOUNTS_MANAGER', 'purchase_order.export')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from matrix m
join public.roles r on r.code = m.role_code
join public.permissions p on p.code = m.permission_code
on conflict do nothing;

-- SUPER_ADMIN: every permission defined so far.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.code = 'SUPER_ADMIN'
on conflict do nothing;
