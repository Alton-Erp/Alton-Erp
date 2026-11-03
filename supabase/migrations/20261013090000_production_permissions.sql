-- =============================================================================
-- Phase 5: manufacturing & outsourcing permissions
--
-- Reused from Phase 2 (equivalent meaning, not duplicated):
--   manufacturing.read  -> production.read (view production overview, orders,
--                          consumption and output)
-- Phase 2's manufacturing.manage is a coarse umbrella permission; Phase 5 uses
-- the granular permissions below instead and no longer checks it.
--
-- Codes are resource.action; the brief's three-part names are mapped to a
-- resource prefix (as in Phase 4), e.g. production.order.create ->
-- production_order.create, production.bom.read -> production_bom.read.
-- =============================================================================

insert into public.permissions (resource, action, description) values
  ('production_bom',       'read',     'View bills of materials'),
  ('production_bom',       'create',   'Create BOMs and new BOM versions, edit own drafts and submit them'),
  ('production_bom',       'update',   'Edit any draft BOM and archive BOMs'),
  ('production_bom',       'approve',  'Approve or reject BOMs'),
  ('production_plan',      'create',   'Plan production and calculate material requirements'),
  ('production_order',     'create',   'Create production orders, edit own drafts and submit them'),
  ('production_order',     'update',   'Edit draft production orders; start, hold and resume production'),
  ('production_order',     'approve',  'Approve or reject production orders'),
  ('production_order',     'complete', 'Complete production orders'),
  ('production_order',     'cancel',   'Cancel production orders'),
  ('production_material',  'reserve',  'Reserve and release raw materials for production orders'),
  ('production_material',  'issue',    'Issue raw materials to production orders'),
  ('production_output',    'receive',  'Record finished-goods output from production'),
  ('production_exception', 'approve',  'Authorise production and outsourcing exceptions: over-consumption, over-production, over-receipt, completion with discrepancies, reversal of posted production and outsourcing transactions'),
  ('production_reports',   'read',     'View production and outsourcing reports and traceability'),
  ('production_reports',   'export',   'Export production and outsourcing reports'),
  ('outsourcing',          'read',     'View outsourcing orders, dispatches and receipts'),
  ('outsourcing_order',    'create',   'Create outsourcing orders, edit own drafts and submit them'),
  ('outsourcing_order',    'approve',  'Approve, reject or cancel outsourcing orders'),
  ('outsourcing_order',    'complete', 'Complete outsourcing orders'),
  ('outsourcing_material', 'dispatch', 'Dispatch company material to suppliers and record material returned'),
  ('outsourcing_receipt',  'create',   'Record goods received from outsourcing suppliers')
on conflict (code) do nothing;

with matrix (role_code, permission_code) as (
  values
    -- ADMIN: oversight and approvals (no shop-floor postings)
    ('ADMIN', 'production_bom.read'), ('ADMIN', 'production_bom.approve'), ('ADMIN', 'production_order.approve'),
    ('ADMIN', 'production_exception.approve'), ('ADMIN', 'production_reports.read'), ('ADMIN', 'production_reports.export'),
    ('ADMIN', 'outsourcing.read'), ('ADMIN', 'outsourcing_order.approve'),

    -- PRODUCTION_MANAGER: runs production end to end (cannot approve own requests: see SoD)
    ('PRODUCTION_MANAGER', 'production_bom.read'), ('PRODUCTION_MANAGER', 'production_bom.create'),
    ('PRODUCTION_MANAGER', 'production_bom.update'), ('PRODUCTION_MANAGER', 'production_bom.approve'),
    ('PRODUCTION_MANAGER', 'production_plan.create'), ('PRODUCTION_MANAGER', 'production_order.create'),
    ('PRODUCTION_MANAGER', 'production_order.update'), ('PRODUCTION_MANAGER', 'production_order.approve'),
    ('PRODUCTION_MANAGER', 'production_order.complete'), ('PRODUCTION_MANAGER', 'production_order.cancel'),
    ('PRODUCTION_MANAGER', 'production_material.reserve'), ('PRODUCTION_MANAGER', 'production_material.issue'),
    ('PRODUCTION_MANAGER', 'production_output.receive'), ('PRODUCTION_MANAGER', 'production_exception.approve'),
    ('PRODUCTION_MANAGER', 'production_reports.read'), ('PRODUCTION_MANAGER', 'production_reports.export'),
    ('PRODUCTION_MANAGER', 'outsourcing.read'), ('PRODUCTION_MANAGER', 'outsourcing_order.create'),
    ('PRODUCTION_MANAGER', 'outsourcing_material.dispatch'), ('PRODUCTION_MANAGER', 'outsourcing_receipt.create'),

    -- INVENTORY_MANAGER: stores side of production (issue, receive, dispatch)
    ('INVENTORY_MANAGER', 'production_bom.read'), ('INVENTORY_MANAGER', 'production_material.issue'),
    ('INVENTORY_MANAGER', 'production_output.receive'), ('INVENTORY_MANAGER', 'production_reports.read'),
    ('INVENTORY_MANAGER', 'outsourcing.read'), ('INVENTORY_MANAGER', 'outsourcing_material.dispatch'),
    ('INVENTORY_MANAGER', 'outsourcing_receipt.create'),

    -- PURCHASE_MANAGER: outsourcing partners
    ('PURCHASE_MANAGER', 'manufacturing.read'), ('PURCHASE_MANAGER', 'production_bom.read'),
    ('PURCHASE_MANAGER', 'production_reports.read'), ('PURCHASE_MANAGER', 'outsourcing.read'),
    ('PURCHASE_MANAGER', 'outsourcing_order.create'), ('PURCHASE_MANAGER', 'outsourcing_order.approve'),
    ('PURCHASE_MANAGER', 'outsourcing_order.complete'), ('PURCHASE_MANAGER', 'outsourcing_receipt.create'),

    -- ACCOUNTS_MANAGER: costing visibility
    ('ACCOUNTS_MANAGER', 'manufacturing.read'), ('ACCOUNTS_MANAGER', 'production_reports.read'),
    ('ACCOUNTS_MANAGER', 'production_reports.export'), ('ACCOUNTS_MANAGER', 'outsourcing.read'),

    -- MANAGEMENT_VIEWER: read only
    ('MANAGEMENT_VIEWER', 'production_bom.read'), ('MANAGEMENT_VIEWER', 'production_reports.read'),
    ('MANAGEMENT_VIEWER', 'outsourcing.read')
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
