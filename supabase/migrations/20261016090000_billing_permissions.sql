-- =============================================================================
-- Phase 8: billing, invoicing and receivables permissions
--
-- Reused (Phase 2): invoices.read, invoices.create (create / edit drafts),
-- invoices.approve (approve drafts submitted for approval, acknowledge tax
-- review items), invoices.cancel, payments.read, payments.manage (record and
-- allocate receipts), customers.read / customers.manage.
-- New: invoices.issue, payments.reverse, invoice_adjustments.create / .issue,
-- billing_settings.manage, billing_reports.read / .export.
-- =============================================================================

insert into public.permissions (resource, action, description) values
  ('invoices',            'issue',  'Issue sales invoices (assigns the official invoice number)'),
  ('payments',            'reverse', 'Reverse payment receipts and payment allocations'),
  ('invoice_adjustments', 'create', 'Create draft credit and debit notes'),
  ('invoice_adjustments', 'issue',  'Issue or cancel credit and debit notes'),
  ('billing_settings',    'manage', 'Configure invoice numbering, tax, payment terms, bank and footer details'),
  ('billing_reports',     'read',   'View billing dashboards, receivables, statements and tax summaries'),
  ('billing_reports',     'export', 'Export billing reports')
on conflict (code) do nothing;

with matrix (role_code, permission_code) as (
  values
    ('ACCOUNTS_MANAGER', 'invoices.issue'), ('ACCOUNTS_MANAGER', 'payments.reverse'), ('ACCOUNTS_MANAGER', 'invoice_adjustments.create'),
    ('ACCOUNTS_MANAGER', 'invoice_adjustments.issue'), ('ACCOUNTS_MANAGER', 'billing_reports.read'), ('ACCOUNTS_MANAGER', 'billing_reports.export'),
    ('ACCOUNTS_MANAGER', 'fulfilment.read'),

    ('ADMIN', 'billing_settings.manage'), ('ADMIN', 'billing_reports.read'), ('ADMIN', 'billing_reports.export'),

    ('SALES_MANAGER', 'invoices.create'), ('SALES_MANAGER', 'payments.read'), ('SALES_MANAGER', 'billing_reports.read'),

    ('INVENTORY_MANAGER', 'invoices.read'),

    ('MANAGEMENT_VIEWER', 'billing_reports.read')
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
