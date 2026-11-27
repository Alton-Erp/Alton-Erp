// UI smoke test for the Product Master (Phase 3).
//
// Serves the production build, points it at a MOCK Supabase API (auth + REST)
// and drives headless Microsoft Edge/Chrome over the DevTools protocol through
// the real login form and product pages. It checks UI wiring: requests sent,
// pages rendered, no console errors. It does NOT test security: RLS and
// permissions are verified against real PostgreSQL by `npm run test:db`.
//
//   npm run build:smoke && npm run test:ui
//
// The mock data below exists only inside this test process.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as XLSX from 'xlsx'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = path.join(root, 'tests', 'ui-smoke', 'output')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const API_PORT = 54329
const APP_PORT = 4180
const CDP_PORT = 9339
const COMPANY_ID = '11111111-1111-4111-8111-111111111111'

// ---------------------------------------------------------------------------
// Mock Supabase API
// ---------------------------------------------------------------------------
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const fakeJwt = (sub) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`

const USERS = {
  'manager@test.invalid': {
    id: '22222222-2222-4222-8222-222222222222',
    roles: ['INVENTORY_MANAGER'],
    permissions: ['dashboard.read', 'products.read', 'products.create', 'products.update', 'products.archive', 'products.import', 'products.export', 'product_categories.manage',
      'inventory.read', 'inventory.create', 'inventory.adjust', 'inventory.approve_adjustment', 'inventory.export', 'inventory_opening.create', 'inventory_opening.approve',
      'inventory_transfer.create', 'inventory_count.create', 'inventory_count.approve', 'inventory_reservation.create', 'inventory_reservation.release',
      'inventory_reports.read', 'inventory_warehouse.manage', 'inventory_location.manage', 'inventory_batch.read', 'inventory_reconciliation.run', 'inventory_alerts.acknowledge',
      'manufacturing.read', 'production_bom.read', 'production_bom.create', 'production_bom.update', 'production_bom.approve', 'production_plan.create', 'production_order.create',
      'production_order.update', 'production_order.approve', 'production_order.complete', 'production_order.cancel', 'production_material.reserve', 'production_material.issue',
      'production_output.receive', 'production_exception.approve', 'production_reports.read', 'production_reports.export', 'outsourcing.read', 'outsourcing_order.create',
      'outsourcing_order.approve', 'outsourcing_order.complete', 'outsourcing_material.dispatch', 'outsourcing_receipt.create',
      'customer_po.read', 'customer_po.import', 'customer_po.match', 'customer_po.update', 'customer_po.revise', 'customer_po.cancel', 'customer_po.allocate',
      'customer_po.release', 'customer_po.fulfil', 'customer_po_shortages.read', 'customer_po_reports.export', 'customers.read', 'customers.manage',
      'sales_orders.read', 'sales_orders.create', 'sales_orders.confirm', 'sales_orders.update', 'sales_orders.cancel', 'fulfilment.read', 'fulfilment.pick',
      'fulfilment.pack', 'fulfilment.dispatch', 'fulfilment_delivery.update', 'fulfilment_returns.create', 'fulfilment_returns.inspect', 'fulfilment_returns.approve',
      'fulfilment_returns.receive_stock', 'fulfilment_reservations.release', 'fulfilment_reports.read', 'fulfilment_reports.export',
      'invoices.read', 'invoices.create', 'invoices.issue', 'invoices.approve', 'invoices.cancel', 'payments.read', 'payments.manage', 'payments.reverse',
      'invoice_adjustments.create', 'invoice_adjustments.issue', 'billing_settings.manage', 'billing_reports.read', 'billing_reports.export',
      'reports.read', 'audit_logs.read',
      'approvals.read', 'approvals.manage', 'documents.read', 'documents.upload', 'documents.manage', 'bulk_operations.read', 'system_health.read', 'users.manage', 'settings.manage',
      'suppliers.read', 'suppliers.manage', 'purchases.read', 'purchase_order.create', 'purchase_order.update', 'purchase_order.approve', 'purchase_order.send',
      'purchase_order.amend', 'purchase_order.cancel', 'purchase_order.export', 'purchase_receipt.create', 'purchase_exception.approve',
      'marketplace_imports.read', 'amazon.read', 'amazon.manage', 'amazon_ads.request', 'amazon_integration.manage', 'ledger.read', 'supplier_payment.manage'],
  },
  'viewer@test.invalid': {
    id: '33333333-3333-4333-8333-333333333333',
    roles: ['MANAGEMENT_VIEWER'],
    permissions: ['dashboard.read', 'products.read', 'inventory.read', 'inventory_reports.read', 'inventory_batch.read', 'manufacturing.read', 'production_bom.read',
      'production_reports.read', 'outsourcing.read', 'customer_po.read', 'customer_po_shortages.read', 'customers.read',
      'sales_orders.read', 'fulfilment.read', 'fulfilment_reports.read', 'invoices.read', 'payments.read', 'billing_reports.read', 'reports.read',
      'approvals.read', 'documents.read', 'purchases.read'],
  },
}
// Super Admin: everything the manager has plus the ERP reset permission.
USERS['owner@test.invalid'] = {
  id: '44444444-4444-4444-8444-444444444444',
  roles: ['SUPER_ADMIN'],
  permissions: [...USERS['manager@test.invalid'].permissions, 'system.reset_data'],
}
// Invited employees: inactive until they accept (user invitations, migration 20261116090000).
USERS['new.hire@test.invalid'] = { id: '55555555-5555-4555-8555-555555555555', active: false, roles: ['SALES_EXECUTIVE'], permissions: USERS['manager@test.invalid'].permissions }
USERS['revoked.hire@test.invalid'] = { id: '66666666-6666-4666-8666-666666666666', active: false, roles: [], permissions: [] }
// Password reset with a 6-digit code (Supabase /recover + /verify type recovery).
const RESET_EMAIL = 'reset.me@test.invalid'
USERS[RESET_EMAIL] = { id: '77777777-7777-4777-8777-777777777777', roles: ['MANAGEMENT_VIEWER'], permissions: USERS['viewer@test.invalid'].permissions }
const RECOVERY_CODES = ['482913', '605174', '739258', '914306', '268540', '351697']
const recovery = { sends: 0, code: null, expired: false, lastSent: 0 }
// Passwords changed through a verified recovery (default for every account: correct-horse).
const passwords = {}
// Department data management mock: categories and the rows each would change.
const DEPT_CATS = {
  PRODUCTS: [['products.archive_inactive', 'ARCHIVE', 'Archive inactive products', 2, 0, { products: 2 }], ['products.unused_products', 'DELETE', 'Never-used inactive products', 1, 1, { products: 1, product_versions: 1 }]],
  INVENTORY: [['inventory.resolved_alerts', 'RESET', 'Resolved stock alerts', 3, 0, { inventory_alerts: 3 }]],
  PURCHASE: [['purchase.unposted_orders', 'DELETE', 'Draft and cancelled purchase orders', 2, 1, { purchase_orders: 2, purchase_order_lines: 3, purchase_order_events: 4 }]],
  PRODUCTION: [['production.unposted_orders', 'DELETE', 'Draft and cancelled production orders', 0, 0, {}]],
  SALES: [['sales.unposted_orders', 'DELETE', 'Draft and cancelled sales orders', 1, 0, { sales_orders: 1, sales_order_lines: 1 }]],
  BILLING: [['billing.draft_invoices', 'DELETE', 'Draft and discarded invoices', 0, 0, {}]],
  LEDGER: [['ledger.archive_dormant', 'ARCHIVE', 'Deactivate dormant customers and suppliers', 0, 0, {}]],
}
// Purchase & GRN (20261126090000): records with type, status and reasons. 'blocked' = the reported
// situation (0 eligible, 2 blocked); 'mixed' adds eligible orders and a GRN draft.
let deptPurchaseState = 'blocked'
const PD_RECORDS = [
  { category: 'purchase.unposted_orders', table: 'purchase_orders', key: 'po-d1', record: 'PO-000010', type: 'PO', status: 'DRAFT', revision: 0, rows: 3,
    tables: { purchase_orders: 1, purchase_order_lines: 1, purchase_order_events: 1 } },
  { category: 'purchase.unposted_orders', table: 'purchase_orders', key: 'po-c1', record: 'PO-000011', type: 'PO', status: 'CANCELLED', revision: 0, rows: 5,
    tables: { purchase_orders: 1, purchase_order_lines: 1, purchase_order_events: 2, erp_form_drafts: 1 } },
  { category: 'purchase.unposted_receipts', table: 'erp_form_drafts', key: 'grn-d1', record: 'GRN draft (receipt without a PO)', type: 'GRN draft', status: 'DRAFT', rows: 1,
    tables: { erp_form_drafts: 1 } },
]
const PD_BLOCKED = [
  { category: 'purchase.unposted_orders', table: 'purchase_orders', key: 'po-b1', record: 'PO-000002', type: 'PO', status: 'CANCELLED', revision: 0,
    reasons: ['Goods receipt was posted and later reversed: its stock movements are permanent history', 'Stock movement posted for this order'],
    references: [{ table: 'goods_receipts', department: 'PURCHASE', record: 'GRN-000001' }, { table: 'inventory_transactions', department: 'INVENTORY', record: 'TXN-000004' }] },
  { category: 'purchase.unposted_orders', table: 'purchase_orders', key: 'po-b2', record: 'PO-000005', type: 'PO', status: 'DRAFT', revision: 1,
    reasons: ['Opened (approved) before and amended back to draft (revision 1). Cancel it first: a cancelled order without stock movements can be deleted.',
      'Posted goods receipt: stock and the supplier payable were recorded'],
    references: [{ table: 'goods_receipts', department: 'PURCHASE', record: 'GRN-000003' }] },
]
const pdDeleted = new Set()
const pdRecords = () => deptPurchaseState === 'blocked' ? [] : PD_RECORDS.filter((r) => !pdDeleted.has(r.key))
function purchasePreview(codes, keys) {
  const records = pdRecords().filter((r) => codes.includes(r.category) && (!keys || keys.includes(r.key)))
  const blocked = PD_BLOCKED.filter((b) => codes.includes(b.category) && (!keys || keys.includes(b.key)))
  const tables = {}
  for (const r of records) for (const [k, n] of Object.entries(r.tables)) tables[k] = (tables[k] ?? 0) + n
  const total = Object.values(tables).reduce((a, b) => a + b, 0)
  return { department: 'PURCHASE', operation: 'DELETE', categories: codes, plan_hash: `hash-PURCHASE-${records.map((r) => r.key).sort().join('+')}`, tables, total,
    records, records_total: records.length, blocked, blocked_total: blocked.length, affected_departments: total ? ['PURCHASE'] : [],
    by_category: codes.map((c) => ({ code: c, label: c, description: c, records: records.filter((r) => r.category === c).length,
      rows: records.filter((r) => r.category === c).reduce((n, r) => n + r.rows, 0), blocked: blocked.filter((b) => b.category === c).length })) }
}
const deptOverview = () => Object.entries(DEPT_CATS).map(([department, cats]) => ({ department,
  categories: department === 'PURCHASE'
    ? [['purchase.unposted_orders', 'Draft and cancelled purchase orders'], ['purchase.unposted_receipts', 'Unposted GRN drafts']].map(([code, label]) => {
      const p = purchasePreview([code], null)
      return { code, operation: 'DELETE', label, description: label, records: p.records_total, rows: p.total, blocked: p.blocked_total }
    })
    : cats.map(([code, operation, label, records, blocked]) => ({ code, operation, label, description: label, records, rows: records, blocked })) }))
function deptPreview(dept, op, codes, keys = null) {
  if (dept === 'PURCHASE' && op === 'DELETE') return purchasePreview(codes, keys)
  const cats = (DEPT_CATS[dept] ?? []).filter(([code, operation]) => operation === op && codes.includes(code))
  const tables = {}
  for (const c of cats) for (const [k, n] of Object.entries(c[5])) tables[k] = (tables[k] ?? 0) + n
  const total = Object.values(tables).reduce((a, b) => a + b, 0)
  const blocked = cats.filter((c) => c[4] > 0).map((c) => ({ category: c[0], table: 'purchase_orders', key: 'po2', record: c[0] === 'purchase.unposted_orders' ? 'PO-000002' : 'OSC-000001',
    reasons: ['Used by goods receipts'], references: [{ table: 'goods_receipts', department: 'PURCHASE', record: 'GRN-000001' }] }))
  return { department: dept, operation: op, categories: codes, plan_hash: 'hash-' + dept + op + codes.join(','), tables, total,
    by_category: cats.map(([code, , label, records, b]) => ({ code, label, description: label, records, rows: records, blocked: b })),
    blocked, blocked_total: blocked.length, affected_departments: total ? [dept, ...(blocked.length ? ['PURCHASE'] : [])] : [] }
}
let deptBackup = null
const deptRuns = []
const INVITE_LINKS = { validhash123: 'new.hire@test.invalid', revokedhash123: 'revoked.hire@test.invalid' }
const perm = (code, description) => ({ code, description })
const ROLE_CATALOG = [
  { id: 'r-super', code: 'SUPER_ADMIN', name: 'Super Admin', description: 'Full control of the company, users and system settings.', category: 'Administration', is_admin: true,
    modules: ['system', 'users'], permissions: [perm('system.reset_data', 'Reset ERP data'), perm('users.manage', 'Manage users and roles')] },
  { id: 'r-admin', code: 'ADMIN', name: 'Administrator', description: 'Manages users, settings and approvals.', category: 'Administration', is_admin: true,
    modules: ['settings', 'users'], permissions: [perm('settings.manage', 'Manage settings'), perm('users.manage', 'Manage users and roles')] },
  { id: 'r-sales', code: 'SALES_EXECUTIVE', name: 'Sales Executive', description: 'Creates and follows up sales orders.', category: 'Sales & Commercial', is_admin: false,
    modules: ['customers', 'sales_orders'], permissions: [perm('customers.read', 'View customers'), perm('sales_orders.create', 'Create sales orders'), perm('sales_orders.read', 'View sales orders')] },
  { id: 'r-dispatch', code: 'DISPATCH_EXECUTIVE', name: 'Dispatch Executive', description: 'Picks, packs and dispatches orders.', category: 'Dispatch & Fulfilment', is_admin: false,
    modules: ['fulfilment'], permissions: [perm('fulfilment.dispatch', 'Dispatch goods'), perm('fulfilment.read', 'View fulfilment')] },
  { id: 'r-accounts', code: 'ACCOUNTS_EXECUTIVE', name: 'Accounts Executive', description: 'Records invoices and payments.', category: 'Finance & Accounts', is_admin: false,
    modules: ['invoices', 'payments'], permissions: [perm('invoices.create', 'Create invoices'), perm('payments.read', 'View payments')] },
]
const inviteRow = (over) => ({ id: `inv-${over.email}`, full_name: 'X', employee_id: null, department: null, designation: null, reporting_manager: null,
  roles: [{ id: 'r-sales', code: 'SALES_EXECUTIVE', name: 'Sales Executive' }], status: 'PENDING', email_status: 'SENT', email_error: null, delivery_method: 'AUTH_INVITE',
  invited_at: '2026-11-01T09:00:00Z', invited_by: 'Smoke Tester', expires_at: '2026-11-02T09:00:00Z', last_sent_at: '2026-11-01T09:00:00Z', send_count: 1,
  accepted_at: null, revoked_at: null, revoked_by: null, revoke_reason: null, user_id: null, ...over })
const invitationRows = [
  inviteRow({ email: 'accepted.user@test.invalid', full_name: 'Accepted User', status: 'ACCEPTED', accepted_at: '2026-11-01T10:00:00Z', user_id: '22222222-2222-4222-8222-222222222222' }),
  inviteRow({ email: 'late.user@test.invalid', full_name: 'Late User', status: 'EXPIRED' }),
  inviteRow({ email: 'bounce.user@test.invalid', full_name: 'Bounce User', status: 'FAILED', email_status: 'FAILED', email_error: 'Supabase Auth refused the e-mail (HTTP 500): e-mail provider error.' }),
]
// Form drafts per user, form, record and scope (mock of erp_form_drafts).
const formDrafts = new Map()
// Drafts refreshed to the latest versions (draft_refresh_versions).
const draftRefreshed = new Set()
let draftFailures = 0
const draftKeyOf = (b) => `${currentUser?.id}|${b?.p_form_key}|${b?.p_record_id ?? ''}|${b?.p_scope ?? ''}`
const draftJson = (row) => ({ ...row, data: row.status === 'draft' ? row.data : null })
let currentUser = null
// ERP reset mock: preview figures and the Edge Function's verified result.
const RESET_PREVIEW = () => ({
  company_id: COMPANY_ID, can_reset: true, blockers: [], delete_total: 7, kept_suppliers: 1, generated_at: new Date().toISOString(), recent_runs: [],
  delete: [
    { table: 'customers', category: 'Customers & suppliers', label: 'Customers', rows: 4 },
    { table: 'suppliers', category: 'Customers & suppliers', label: 'Suppliers', rows: 1 },
    { table: 'notifications', category: 'Approvals, notifications & imports', label: 'Notifications', rows: 2 },
    { table: 'boms', category: 'Production & BOMs', label: 'Bills of materials', rows: 0 },
  ],
  keep: [{ table: 'profiles', label: 'User profiles', rows: 3 }, { table: 'products', label: 'Products', rows: 4 },
    { table: 'suppliers', label: 'Suppliers named as a product\'s preferred supplier', rows: 1 }],
})
// Force reset mock (direct delete since 20261113: no approval, backup or password).
// invoice_dispatch_status mock: false = every stock line dispatched (ready to post).
let dispatchBlocked = false
// Partial invoicing mocks (20261115): invoice_partial_preview reports a partial invoice when true;
// the pending 2 PCS of SO-000001 are released by sales_order_line_release_pending.
let partialPreview = false
let pendingReleased = false
const trackingLine = () => ({
  sales_order_id: 'so1', sales_order_number: 'SO-000001', order_date: '2026-10-28', order_status: 'CONFIRMED', customer_id: 'cu1', customer_name: 'Acme Ltd',
  line_id: 'sol1', line_no: 1, product_id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', ordered: 10, cancelled: 0,
  released: pendingReleased ? 2 : 0, effective: pendingReleased ? 8 : 10, invoiced: 8, draft_invoiced: 0, dispatched: 8, pending: pendingReleased ? 0 : 2,
  releasable: pendingReleased ? 0 : 2, invoice_numbers: ['INV/26-27/0001'], latest_invoice_id: 'inv2', latest_invoice_number: 'INV/26-27/0001',
  latest_invoice_date: '2026-11-01', status: pendingReleased ? 'CLOSED' : 'PARTIALLY_INVOICED',
})
const forceRuns = [
  { id: 'run0', mode: 'STANDARD', status: 'BLOCKED', started_at: '2026-10-30T09:00:00Z', finished_at: '2026-10-30T09:00:01Z', requested_by: '44444444-4444-4444-8444-444444444444',
    deleted_total: 0, deleted_counts: {}, blockers: [{ kind: 'PROTECTED_RECORDS', table: 'inventory_transactions', label: 'Stock ledger', rows: 40, reason: 'Posted stock movements are permanent.' }],
    error_message: 'Nothing was deleted. Some records are protected by the database and cannot be deleted.', backup_id: null, approval_id: null },
]
const FORCE_PREVIEW = () => ({
  company: { id: COMPANY_ID, code: 'TEST', name: 'Test Co' },
  tables: [
    { table: 'inventory_transactions', category: 'Inventory', label: 'Stock ledger', rows: 40, order: 1, protected: true, protection: 'Posted stock movements are permanent; corrections are reversal entries.' },
    { table: 'sales_invoices', category: 'Billing & receivables', label: 'Sales invoices', rows: 3, order: 2, protected: true, protection: 'Invoices are never deleted; drafts are discarded and issued invoices cancelled.' },
    { table: 'customers', category: 'Customers & suppliers', label: 'Customers', rows: 4, order: 3, protected: false, protection: null },
    { table: 'products', category: 'Products & catalogue', label: 'Products', rows: 4, order: 4, protected: false, protection: null },
  ],
  delete_total: 51, protected_total: 43,
  retained: [{ table: 'profiles', label: 'User profiles', reason: 'Every user account is kept.', rows: 3 },
    { table: 'audit_logs', label: 'Audit log', reason: 'Security record.', rows: 120 },
    { table: 'documents', label: 'Company-level documents and their files', reason: 'Kept.', rows: 1 }],
  blockers: [], unaffected_tables: ['permissions', 'roles'], discovered_tables: 102, demo_presentation_data: 'RESETTABLE',
  storage: { product_images: 2, documents: 1 },
  approval: null,
  backup: null,
  gates: { authorized: true, environment_approved: true, backup_verified: true, plan_reviewed: true },
  can_execute: true,
  generated_at: new Date().toISOString(),
})

const categories = [
  { id: 'c1', company_id: COMPANY_ID, name: 'Wash Basins', code: 'WASH_BASINS', description: null, is_active: true, created_by: null, updated_by: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
  { id: 'c2', company_id: COMPANY_ID, name: 'Water Closets / Toilets', code: 'WATER_CLOSETS', description: null, is_active: true, created_by: null, updated_by: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
  { id: 'c3', company_id: COMPANY_ID, name: 'Retired', code: 'RETIRED', description: null, is_active: false, created_by: null, updated_by: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
]
const product = (n, extra = {}) => ({
  id: `p${n}`, company_id: COMPANY_ID, sku: `MOCK-WC-${n}`, product_name: `Mock Closet ${n}`, description: null, category_id: 'c2',
  brand: null, model_number: null, barcode: null, product_image_path: null, status: 'ACTIVE', archived_at: null, archived_by: null,
  product_type: 'FINISHED_GOOD', default_source_type: 'IN_HOUSE', base_unit: 'PCS', track_batches: false, track_expiry: false,
  hsn_code: '6910', gst_rate: 18, selling_price: 9800, standard_cost: null, minimum_selling_price: null, reorder_level: null,
  preferred_supplier_id: null, is_manufacturable: true, has_bom: false, production_notes: null,
  created_by: USERS['manager@test.invalid'].id, updated_by: null, created_at: '2026-10-02T10:00:00Z', updated_at: '2026-10-02T10:00:00Z', ...extra,
})
const products = [product(1, { barcode: '8901234567890', reorder_level: 10 }), product(2, { default_source_type: 'HYBRID', status: 'INACTIVE' }),
  product(3, { sku: 'MOCK-CLAY', product_name: 'Mock ceramic body', product_type: 'RAW_MATERIAL', base_unit: 'KG', category_id: null }),
  product(4, { sku: 'MOCK-GLZ', product_name: 'Mock glaze', product_type: 'RAW_MATERIAL', base_unit: 'KG', track_batches: true, category_id: null })]

// --- Inventory mock data (exists only in this test process) ---------------
const MANAGER_ID = USERS['manager@test.invalid'].id
const VIEWER_ID = USERS['viewer@test.invalid'].id
const NOW = new Date().toISOString()
const TODAY = NOW.slice(0, 10)

// ---------------------------------------------------------------------------
// Alton Accounts (migrations 20261231090000 / 20261231090100): mock accounting API
// ---------------------------------------------------------------------------
const ACC_FY = TODAY.slice(5, 7) >= '04' ? Number(TODAY.slice(0, 4)) : Number(TODAY.slice(0, 4)) - 1
const ACC_START = `${ACC_FY}-04-01`
const ACC_FY_LABEL = `${ACC_FY}-${String((ACC_FY + 1) % 100).padStart(2, '0')}`
const ACC = {
  posted: 0,
  runs: 0,
  groups: [
    { id: 'ag-as', group_code: 'AS', group_name: 'Assets', parent_group_id: null, classification: 'ASSET', normal_balance: 'DEBIT', is_system: true, is_active: true, sort_order: 1, description: null },
    { id: 'ag-bank', group_code: 'AS.CA.BANK', group_name: 'Bank Accounts', parent_group_id: 'ag-as', classification: 'ASSET', normal_balance: 'DEBIT', is_system: true, is_active: true, sort_order: 5, description: null },
    { id: 'ag-deb', group_code: 'AS.CA.DEB', group_name: 'Sundry Debtors', parent_group_id: 'ag-as', classification: 'ASSET', normal_balance: 'DEBIT', is_system: true, is_active: true, sort_order: 6, description: null },
    { id: 'ag-in', group_code: 'IN', group_name: 'Income', parent_group_id: null, classification: 'INCOME', normal_balance: 'CREDIT', is_system: true, is_active: true, sort_order: 19, description: null },
    { id: 'ag-sal', group_code: 'IN.SAL', group_name: 'Sales Accounts', parent_group_id: 'ag-in', classification: 'INCOME', normal_balance: 'CREDIT', is_system: true, is_active: true, sort_order: 20, description: null },
  ],
}
const accAccount = (id, code, name, group, cls, nature, balance, extra = {}) => ({ id, account_code: code, account_name: name, group_id: group, group_name: ACC.groups.find((g) => g.id === group).group_name,
  classification: cls, normal_balance: cls === 'ASSET' ? 'DEBIT' : 'CREDIT', account_nature: nature, is_postable: true, allow_manual_posting: true, requires_party: false, is_control: false,
  is_system: false, system_key: null, is_active: true, description: null, balance, line_count: 2, ...extra })
ACC.accounts = [
  accAccount('acc-bank', '1210', 'HDFC Current A/c', 'ag-bank', 'ASSET', 'BANK', '11800.00'),
  accAccount('acc-deb', '1300', 'Sundry Debtors (Control)', 'ag-deb', 'ASSET', 'RECEIVABLE_CONTROL', '0.00', { requires_party: true, allow_manual_posting: false, is_control: true, is_system: true }),
  accAccount('acc-sales', '4100', 'Sales', 'ag-sal', 'INCOME', 'GENERAL', '-10000.00', { is_system: true }),
  accAccount('acc-gst', '2210', 'Output CGST', 'ag-sal', 'INCOME', 'TAX', '-1800.00', { is_system: true }),
]
const accLine = (n, acc, dr, cr, party = null) => { const a = ACC.accounts.find((x) => x.id === acc); return { id: `al${n}`, line_no: n, account_id: acc, account_code: a.account_code,
  account_name: a.account_name, party_id: party, party_name: party ? 'Mock Customer' : null, debit: dr, credit: cr, narration: null } }
const accVoucher = (over = {}) => ({ id: 'av1', voucher_type: 'SAL', voucher_type_name: 'Sales', voucher_number: `SAL/${ACC_FY_LABEL.slice(2)}/000001`, financial_year: ACC_FY_LABEL,
  voucher_date: TODAY, reference_number: 'INV/1', narration: 'Sales invoice INV/1 — Mock Customer', status: 'POSTED', source: 'AUTO', source_type: 'SALES_INVOICE', source_id: 'inv1',
  source_number: 'INV/1', reversal_of_voucher_id: null, reversal_of_number: null, reversed_by_voucher_id: null, reversed_by_number: null, reversal_reason: null, reversed_at: null,
  reversed_by_name: null, total_debit: '11800.00', total_credit: '11800.00', row_version: 2, created_at: NOW, created_by_name: 'Smoke Tester', updated_at: NOW, posted_at: NOW,
  posted_by_name: 'Smoke Tester', discarded_at: null, discard_reason: null,
  lines: [accLine(1, 'acc-deb', '11800.00', '0', 'party1'), accLine(2, 'acc-sales', '0', '10000.00'), accLine(3, 'acc-gst', '0', '1800.00')],
  issues: [], audit: [{ action: 'accounting.voucher.posted', at: NOW, by: 'Smoke Tester', metadata: {} }], ...over })
const accDraft = () => accVoucher({ id: 'av2', voucher_type: 'JV', voucher_type_name: 'Journal Voucher', voucher_number: null, status: 'DRAFT', source: 'MANUAL', source_type: null, source_id: null,
  source_number: null, posted_at: null, posted_by_name: null, narration: 'Bank charges', lines: [accLine(1, 'acc-bank', '0', '250.00'), accLine(2, 'acc-sales', '250.00', '0')] })
const accListRow = (v) => ({ id: v.id, voucher_number: v.voucher_number, voucher_type: v.voucher_type, voucher_type_name: v.voucher_type_name, voucher_date: v.voucher_date,
  reference_number: v.reference_number, narration: v.narration, status: v.status, source: v.source, source_type: v.source_type, source_number: v.source_number, total_debit: v.total_debit,
  total_credit: v.total_credit, reversal_of_voucher_id: null, created_by: MANAGER_ID, created_by_name: 'Smoke Tester', created_at: NOW, posted_at: v.posted_at })
const accTbRow = (a, opening, dr, cr) => ({ account_id: a.id, account_code: a.account_code, account_name: a.account_name, group_name: a.group_name, classification: a.classification,
  normal_balance: a.normal_balance, is_active: true, opening_debit: '0', opening_credit: '0', period_debit: dr, period_credit: cr,
  closing_debit: Number(dr) > Number(cr) ? (Number(dr) - Number(cr)).toFixed(2) : '0', closing_credit: Number(cr) > Number(dr) ? (Number(cr) - Number(dr)).toFixed(2) : '0' })
const accEvents = () => [
  { id: 'ae1', source_type: 'SALES_INVOICE', source_id: 'inv1', event_action: 'POST', source_number: 'INV/1', source_date: TODAY, amount: '11800.00', status: 'POSTED', attempts: 0,
    last_attempt_at: NOW, error_code: null, error_message: null, voucher_id: 'av1', voucher_number: accVoucher().voucher_number, dismiss_reason: null, dismissed_at: null, posted_at: NOW, created_at: NOW },
  { id: 'ae2', source_type: 'CUSTOMER_RECEIPT', source_id: 'rc1', event_action: 'POST', source_number: 'RCPT/1', source_date: TODAY, amount: '5000.00', status: 'NEEDS_ACCOUNT_MAPPING',
    attempts: 0, last_attempt_at: NOW, error_code: 'NEEDS_ACCOUNT_MAPPING', error_message: 'Map an active account in Accounting Settings > Posting rules for: Customer receipts by upi (cash / bank account).',
    voucher_id: null, voucher_number: null, dismiss_reason: null, dismissed_at: null, posted_at: null, created_at: NOW },
]
const accPeriods = () => Array.from({ length: 12 }, (_, i) => { const d = new Date(Date.UTC(ACC_FY, 3 + i, 1)); const e = new Date(Date.UTC(ACC_FY, 4 + i, 0))
  return { id: `ap${i + 1}`, financial_year: ACC_FY_LABEL, period_no: i + 1, period_name: d.toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
    start_date: d.toISOString().slice(0, 10), end_date: e.toISOString().slice(0, 10), status: 'OPEN', status_reason: null, closed_at: null, reopened_at: null, draft_vouchers: 0, posted_vouchers: i === 0 ? 1 : 0 } })
const accOpening = () => ({ id: 'ob1', batch_number: 'OB-0001', as_of_date: ACC_START, source: 'MANUAL', file_name: null, notes: null, status: 'DRAFT', acknowledgements: [],
  voucher_number: null, created_by_name: 'Smoke Tester', approved_by_name: null, posted_by_name: null, created_at: NOW, approved_at: null, posted_at: null,
  line_total_debit: '5000.00', line_total_credit: '5000.00',
  lines: [{ id: 'obl1', line_no: 1, account_id: 'acc-bank', account_code: '1210', account_name: 'HDFC Current A/c', party_id: null, party_name: null, party_code: null, balance_category: 'CASH_BANK',
    debit: '5000.00', credit: '0', description: 'Bank balance' }, { id: 'obl2', line_no: 2, account_id: 'acc-sales', account_code: '4100', account_name: 'Sales', party_id: null, party_name: null,
    party_code: null, balance_category: 'LEDGER', debit: '0', credit: '5000.00', description: null }],
  checks: [{ code: 'BALANCED', label: 'Total debit equals total credit', status: 'PASS', acknowledgeable: false, expected: '5000.00', actual: '5000.00', difference: '0' },
    { code: 'RECEIVABLE_MATCH', label: 'Debtors equal the ERP customer opening balances, party by party', status: 'FAIL', acknowledgeable: true, expected: '2000.00', actual: '0', difference: '-2000.00',
      details: [{ party: 'Mock Customer', erp: 2000, batch: 0, difference: -2000 }] }] })
const ACC_CC = () => [
  { id: 'cc1', cost_centre_code: 'PROD', cost_centre_name: 'Production', description: null, parent_cost_centre_id: null, cost_centre_type: 'PRODUCTION', effective_from: null,
    effective_to: null, is_active: true, updated_at: NOW, allocation_count: 3, posted_allocation_count: 3, budget_line_count: 1, child_count: 0 },
  { id: 'cc2', cost_centre_code: 'ADMIN', cost_centre_name: 'Administration', description: 'Office', parent_cost_centre_id: null, cost_centre_type: 'ADMINISTRATION', effective_from: null,
    effective_to: null, is_active: true, updated_at: NOW, allocation_count: 0, posted_allocation_count: 0, budget_line_count: 0, child_count: 1 },
  { id: 'cc3', cost_centre_code: 'WH', cost_centre_name: 'Warehouse', description: null, parent_cost_centre_id: 'cc2', cost_centre_type: 'WAREHOUSE', effective_from: null,
    effective_to: null, is_active: true, updated_at: NOW, allocation_count: 0, posted_allocation_count: 0, budget_line_count: 0, child_count: 0 },
]
const accBudget = (status = 'DRAFT') => ({ id: 'bud1', financial_year: ACC_FY_LABEL, fy_start: ACC_START, version: 1, budget_name: 'Operating budget', status, source: 'IMPORT', notes: null,
  file_name: 'budget.xlsx', revision_of_budget_id: null, revision_of_version: null, created_at: NOW, approved_at: status === 'APPROVED' ? NOW : null, created_by_name: 'Smoke Tester',
  approved_by_name: status === 'APPROVED' ? 'Smoke Tester' : null, total_annual: '600000.00',
  lines: [{ id: 'bl1', line_no: 1, cost_centre_id: 'cc1', cost_centre_code: 'PROD', cost_centre_name: 'Production', account_id: 'acc-sales', account_code: '4100', account_name: 'Sales',
    classification: 'INCOME', annual_amount: '600000.00', months: Array(12).fill('50000.00'), notes: null }],
  history: [{ action: 'CREATED', note: null, at: NOW, by: 'Smoke Tester', details: {} }, { action: 'IMPORTED', note: null, at: NOW, by: 'Smoke Tester', details: {} }] })
// Supplier invoices (Phase 3): one invoice moving SUBMITTED (price variance) → APPROVED → POSTED → GST verified → paid.
const PI = { status: 'SUBMITTED', gst: 'PENDING_VERIFICATION', paid: 0, proposed: null }
// GSTR-2B (Phase 5, Gate C): one verified import with an error row, one partial match awaiting approval.
const G2B = { committed: false, approved: false }
// GST returns (Phase 5, Gate D): one approved period (snapshot) and one open period (live, adjusted).
const GR = { filed: null, closed: false }
const grSec = (taxable, igst, cgst, sgst, docs = 1, adj = null) => ({ label: null, calculated: { documents: docs, taxable, igst, cgst, sgst, cess: '0' },
  adjusted: { documents: docs, taxable: adj ?? taxable, igst, cgst, sgst, cess: '0' }, value_status: adj ? 'ADJUSTED' : 'CALCULATED',
  adjustments: adj ? [{ id: 'ra1', field: 'taxable', tax_head: 'TAXABLE', amount: '500.00', reason: 'Advance received, tax paid', status: 'APPROVED' }] : [], rows: [] })
const grBase = (period, approved) => ({ period: period === 'gp-oct' ? '2026-10' : '2026-11', from: period === 'gp-oct' ? '2026-10-01' : '2026-11-01', to: period === 'gp-oct' ? '2026-10-31' : '2026-11-30',
  config_version_no: 1, unmatched_adjustments: [], source: approved ? 'SNAPSHOT' : 'LIVE',
  value_status: approved ? (GR.filed ? 'FILED' : 'APPROVED') : 'ADJUSTED', period_status: approved ? 'APPROVED' : 'UNDER_REVIEW',
  snapshot: approved ? { id: 'gs1', version_no: 1, snapshot_hash: 'b'.repeat(64), created_at: NOW, has_return_working: true } : null, live_differs: false,
  filing: approved && GR.filed ? { id: 'gf1', return_type: 'GSTR3B', arn: GR.filed, filed_on: TODAY, note: null, recorded_by_name: 'Smoke Tester', recorded_at: NOW, note_on_filing: 'Recorded by a user' } : null,
  exceptions: [{ code: 'MISSING_HSN', severity: 'ERROR', source_kind: 'SALES_INVOICE', source_id: 'si9', document_no: 'INV-0009', document_date: TODAY, message: '1 line(s) without HSN / SAC.' }],
  disclaimer: 'Working data for preparing the return on the GST portal. This system does not file returns and has no GSTN / portal connection.' })
const grGstr1 = (period, approved) => ({ ...grBase(period, approved), return_type: 'GSTR1', b2cl_invoice_threshold: 100000,
  sections: { B2B: { ...grSec('1000.00', '180.00', '0', '0'), rows: [{ kind: 'INVOICE', id: 'si1', number: 'INV-0001', date: TODAY, customer: 'Acme', gstin: '29AABCQ1234A1Z5',
    place_of_supply: '29', value: '1180.00', sign: 1, taxable: '1000.00', igst: '180.00', cgst: '0', sgst: '0', cess: '0', rates: [{ rate: 18, taxable: '1000.00', igst: '180.00', cgst: '0', sgst: '0' }] }] },
    B2CS: grSec('500.00', '0', '45.00', '45.00'), CDNR: grSec('-100.00', '-18.00', '0', '0') },
  hsn: [{ hsn_sac: '6910', uqc: 'PCS', rate: 18, b2b: true, quantity: 2, taxable: '900.00', igst: '162.00', cgst: '0', sgst: '0', cess: '0' }],
  documents_issued: [{ nature: 'Invoices for outward supply', series: 'INV', from: 'INV-0001', to: 'INV-0007', total: 7, cancelled: 1, net_issued: 6 }],
  excluded: { draft_or_pending: 2, cancelled: 1, proforma: 0 } })
const grGstr3b = (period, approved) => ({ ...grBase(period, approved), return_type: 'GSTR3B',
  sections: { '3.1(a)': grSec('201500.00', '36180.00', '45.00', '45.00', 0, approved ? null : '202000.00'), '3.1(b)': grSec('2000.00', '0', '0', '0', 0), '4(A)(5)': grSec('0', '90.00', '90.00', '90.00', 0) },
  net_itc: { igst: '90.00', cgst: '90.00', sgst: '90.00', cess: '0' }, '3.2_inter_state_unregistered': [{ place_of_supply: '29', taxable: '200000.00', igst: '36000.00' }],
  '6.1': [{ head: 'IGST', payable_per_return: '36180.00', liability_per_ledger: '200.00', paid_through_itc: { IGST: '150.00' }, paid_in_cash: '0', interest: '0', late_fee: '0', open_after_set_off: '50.00' }],
  credit: { IGST: { accrued_to_period_end: '500.00', used_to_period: '150.00', used_in_posted_set_offs: '510.00', available_at_period_end: '350.00', cumulative_headroom: '350.00',
    ledger_balance: '440.00', current_available: '440.00', available: '350.00' } },
  itc_evidence: { note: 'GSTR-2B results are evidence only: ITC comes from approved maker-checker decisions, never from GSTR-2B.', by_gstr2b_status: { APPROVED: { decisions: 1, itc: '180.00' } }, events: [] } })
const grPeriods = () => [{ id: 'gp-nov', period_code: '2026-11', frequency: 'MONTHLY', period_start: '2026-11-01', period_end: '2026-11-30', status: 'UNDER_REVIEW', snapshot_version: null,
    open_amendments: 0, prepared_by: null, row_version: 2 },
  { id: 'gp-oct', period_code: '2026-10', frequency: 'MONTHLY', financial_year: '2026-27', period_start: '2026-10-01', period_end: '2026-10-31', status: GR.closed ? 'CLOSED' : 'APPROVED',
    snapshot_version: 1, open_amendments: 0, prepared_by: 'u2', row_version: GR.closed ? 6 : 5 }]
const geControls = () => [...['SNAPSHOT_MISSING', 'GST_ACCOUNTS_UNMAPPED', 'ADJUSTMENTS_DRAFT', 'AMENDMENTS_UNRESOLVED', 'ITC_PROPOSALS_PENDING', 'GSTR2B_UNAPPROVED_MATCHES', 'SET_OFF_DRAFT',
  'PAYMENTS_UNPOSTED'].map((code) => ({ code, severity: 'BLOCKER', count: 0, passed: true, message: `${code} message` })),
  { code: 'SOURCE_ERRORS', severity: 'WARNING', count: 2, passed: false, message: 'Source documents with missing or invalid GST information.' },
  { code: 'LEDGER_UNRECONCILED', severity: 'WARNING', count: 0, passed: true, message: 'Tax heads where documents and GST ledgers differ.' }]
const geHead = (report) => ({ report, company: { legal_name: 'Alton Hi-Tech Sanitary Ware', display_name: 'Alton' }, gstin: '27AABCA1234A1Z5', period_id: 'gp-oct', period_code: '2026-10',
  from: '2026-10-01', to: '2026-10-31', financial_year: '2026-27', period_status: GR.closed ? 'CLOSED' : 'APPROVED', config_version_no: 1,
  snapshot: { id: 'gs1', version_no: 1, snapshot_hash: 'b'.repeat(64), created_at: NOW, has_return_working: true }, filings: GR.filed ? [{ return_type: 'GSTR3B', arn: GR.filed, filed_on: TODAY }] : [],
  value_status: GR.filed ? 'FILED' : 'APPROVED', generated_at: NOW,
  disclaimer: 'Prepared by Alton ERP for review and working purposes. This document is not proof of filing with the GST Portal. The taxpayer must independently verify and file the return on the official GST Portal.' })
const g2bImport = () => ({ id: 'g2b1', return_period: '2026-10', file_name: 'GSTR2B_102026.xlsx', file_kind: 'XLSX', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  file_size: 20480, declared_sha256: 'a'.repeat(64), computed_sha256: 'a'.repeat(64), storage_path: 'c/gstr2b/g2b1.xlsx', bucket: 'gst-files', status: G2B.committed ? 'COMMITTED' : 'VERIFIED',
  rejection_reason: null, status_reason: null, total_rows: 3, valid_rows: 2, error_rows: 1, duplicate_rows: 0, parser: { sheets: [{ sheet: 'B2B', section: 'B2B', rows: 3 }], skipped: ['ISD'] },
  commit_summary: G2B.committed ? { NEW: 2, AMENDMENT: 0, CHANGED: 0, DUPLICATE_OF_EARLIER: 0, SKIPPED: 1 } : {}, uploaded_by_name: 'Smoke Tester', committed_by_name: null, created_at: NOW,
  verified_at: NOW, committed_at: G2B.committed ? NOW : null, row_version: 2 })
const g2bLine = (n, status, doc, errors = []) => ({ id: `gl${n}`, line_no: n, sheet_name: 'B2B', source_row: n + 5, section: 'B2B', original_row: { 'GSTIN of supplier': '27AABCP1234A1Z5',
  'Invoice details / Invoice number': doc }, supplier_gstin: '27AABCP1234A1Z5', supplier_name: 'Shree Ceramics', doc_type: 'INVOICE', doc_number: doc, doc_date: TODAY, is_amendment: false,
  original_doc_number: null, taxable_value: '420.00', igst: '0', cgst: '37.80', sgst: '38.30', cess: '0', row_status: status, errors, duplicate_of_line: null, commit_outcome: G2B.committed && status === 'VALID' ? 'NEW' : null })
const g2bMatch = () => ({ id: 'gm1', document_id: 'gd1', purchase_invoice_id: 'pi1', method: 'AUTO', outcome: 'PARTIAL', mismatches: [], differences: { sgst: { gstr2b: 38.3, books: 37.8, difference: 0.5 } },
  tolerance: '1.00', config_version_no: 1,
  status: G2B.approved ? 'APPROVED' : 'PROPOSED', reason: null, decision_note: G2B.approved ? 'Supplier rounding' : null, reversal_reason: null, invoice_number: 'PINV-000001',
  supplier_invoice_number: 'S1/M-002', supplier_gstin: '27AABCP1234A1Z5', doc_number: 'S1/M-002', version_no: 1, is_current_version: true, proposed_by_name: 'Other Accountant',
  decided_by_name: G2B.approved ? 'Smoke Tester' : null, proposed_at: NOW, history: [{ action: 'PROPOSED', reason: null, by: 'Other Accountant', created_at: NOW }] })
const piLookups = () => ({ initialized: true, today: TODAY, books_start_date: ACC_START, pi_price_tolerance_percent: 0, pi_amount_tolerance: 0, company_state_code: '27',
  suppliers: [{ id: 'sup1', supplier_code: 'SUP1', name: 'Shree Ceramics', gstin: '27AABCP1234A1Z5', state_code: '27', payment_terms: 'DAYS_30' }],
  accounts: [{ id: 'acc-6500', account_code: '6500', account_name: 'Electricity', classification: 'EXPENSE', cost_centre_policy: 'REQUIRED' },
    { id: 'acc-6200', account_code: '6200', account_name: 'Rent', classification: 'EXPENSE', cost_centre_policy: 'OPTIONAL' }],
  cost_centres: ACC_CC() })
const piInvoice = (id = 'pi1', status = PI.status) => ({ id, invoice_number: id === 'pi1' ? 'PINV-000001' : 'PINV-000009', supplier_id: 'sup1', supplier_code: 'SUP1',
  supplier_name: 'Shree Ceramics', party_id: 'p-sup1', party_code: 'SUP1', supplier_gstin: '27AABCP1234A1Z5', supplier_invoice_number: id === 'pi1' ? 'S1/M-002' : 'S1/NEW-9',
  supplier_invoice_date: TODAY, recorded_date: TODAY, due_date: TODAY, purchase_order_id: null, purchase_order_number: null, invoice_type: 'GOODS', supply_category: 'TAXABLE',
  place_of_supply_state_code: '27', tax_treatment: 'INTRA_STATE', reverse_charge: false, currency: 'INR', subtotal: '420.00', discount_total: '0', taxable_value: '420.00',
  cgst_total: '37.80', sgst_total: '37.80', igst_total: '0', cess_total: '0', round_off: '0', grand_total: '495.60', supplier_stated_total: '495.60', narration: null, status,
  variance_status: status === 'SUBMITTED' ? 'EXCEPTION' : status === 'DRAFT' ? 'NONE' : 'APPROVED', variance_note: status === 'SUBMITTED' || status === 'DRAFT' ? null : 'Supplier price revision agreed',
  gst_status: status === 'POSTED' ? PI.gst : 'PENDING_VERIFICATION', gst_verification: PI.gst === 'ELIGIBLE' ? { status: 'ELIGIBLE', reason: 'Checked against the supplier copy', checks: {} } : null,
  gst_verified_at: null, voucher_id: status === 'POSTED' ? 'av-pin' : null, voucher_number: status === 'POSTED' ? 'PIN/26-27/000001' : null,
  gst_voucher_id: PI.gst === 'ELIGIBLE' ? 'av-pin2' : null, gst_voucher_number: PI.gst === 'ELIGIBLE' ? 'PIN/26-27/000002' : null,
  reconciliation: status === 'POSTED' ? { lines: [{ line_no: 1, receipt: 'GRN-0001', quantity: 4, receipt_payable_share: '472.00', invoice_amount: '495.60', creditors_adjustment: '23.60' }],
    receipt_share_total: '472.00', creditors_posted_by_invoice: '23.60', invoice_total: '495.60', reconciled: true } : null,
  row_version: 3, created_at: NOW, created_by_name: 'Smoke Tester', approved_at: null, approved_by_name: null, posted_at: status === 'POSTED' ? NOW : null, posted_by_name: null,
  reversed_at: null, reversal_reason: null, cancelled_at: null, cancel_reason: null,
  outstanding: status === 'POSTED' ? (495.6 - PI.paid).toFixed(2) : null, paid: status === 'POSTED' ? PI.paid.toFixed(2) : null,
  lines: [{ id: 'pil1', line_no: 1, line_kind: 'GRN', goods_receipt_id: 'grn1', goods_receipt_line_id: 'grl1', account_id: null, account_code: null, account_name: null,
    description: 'Wash basin', quantity: '4.000', unit_price: '105.0000', discount: '0', taxable_value: '420.00', gst_rate: '18.00', cgst: '37.80', sgst: '37.80', igst: '0', cess: '0',
    matched_net: status === 'POSTED' ? '400.00' : null, matched_gst: status === 'POSTED' ? '72.00' : null, matched_payable: status === 'POSTED' ? '472.00' : null,
    grn_unit_cost: status === 'POSTED' ? '100.0000' : null, grn_gst_rate: status === 'POSTED' ? '18.00' : null, receipt_number: 'GRN-0001', receipt_date: TODAY, product_name: 'Wash basin',
    grn_accepted: '10.000', grn_payable: '1180.00', grn_net: '1000.00', grn_unit_cost_now: '100.0000', grn_rate: '18.00', grn_invoiced_elsewhere: '6.000', allocations: [] }],
  payments: PI.paid ? [{ id: 'spa1', payment_id: 'spay1', payment_number: 'SPAY-0001', payment_date: TODAY, payment_status: 'RECORDED', amount: PI.paid.toFixed(2), status: 'ACTIVE',
    reversal_reason: null, created_at: NOW }] : [],
  history: [{ action: 'CREATED', note: null, details: {}, at: NOW, by: 'Smoke Tester' }, { action: 'SUBMITTED', note: null, details: {}, at: NOW, by: 'Smoke Tester' }],
  issues: status === 'SUBMITTED' ? [{ code: 'PRICE_VARIANCE', blocking: false, line_no: 1, amount: '20.00',
    message: 'Line 1: invoice price 105.00 vs receipt cost 100.00 (difference 20.00, 5%) is outside the tolerance and needs approval.' }] : [] })
// Bank & cash (Phase 4).
const BK = { transfers: [], imports: [], matched: false, adjusted: false, policyCash: false }
const bkAcc = (id, kind, code, name, extra = {}) => ({ id, account_kind: kind, account_code: code, account_name: name, ledger_account_id: 'l-' + id, ledger_code: kind === 'BANK' ? '1230' : '1110',
  ledger_name: name, bank_name: kind === 'BANK' ? 'HDFC Bank' : null, branch_name: kind === 'BANK' ? 'Pune MIDC' : null, account_holder_name: kind === 'BANK' ? 'Alton' : null,
  account_number_masked: kind === 'BANK' ? 'XXXXXXXXXX5678' : null, ifsc: kind === 'BANK' ? 'HDFC0001234' : null, bank_account_type: kind === 'BANK' ? 'CURRENT' : null, currency: 'INR',
  opening_balance: null, opening_balance_type: null, opening_balance_date: null, opening_balance_reference: null, custodian_user_id: null, custodian_name: kind === 'CASH' ? 'Smoke Tester' : null,
  allow_negative_balance: false, is_active: true, notes: null, row_version: 1, ledger_balance: kind === 'BANK' ? '196036.00' : '500.00', last_statement_date: null, unmatched_statement_lines: 0, ...extra })
const BK_ACCOUNTS = () => [bkAcc('hdfc', 'BANK', 'HDFC-CA', 'HDFC Current'), bkAcc('petty', 'CASH', 'PETTY', 'Petty Cash')]
const bkLookups = () => ({ initialized: true, today: TODAY, accounts: BK_ACCOUNTS(),
  ledgers: [{ id: 'l-hdfc', account_code: '1230', account_name: 'HDFC Current', account_nature: 'BANK', linked: true }, { id: 'l-sbi', account_code: '1240', account_name: 'SBI Current', account_nature: 'BANK', linked: false },
    { id: 'l-petty', account_code: '1110', account_name: 'Petty Cash', account_nature: 'CASH', linked: true }],
  expense_ledgers: [{ id: 'acc-6600', account_code: '6600', account_name: 'Bank Charges', cost_centre_policy: 'OPTIONAL' }], users: [{ id: 'u1', full_name: 'Smoke Tester' }] })
const bkTransfer = (t) => ({ voucher_id: null, voucher_number: null, reversal_voucher_number: null, reversal_reason: null, cancel_reason: null, row_version: 1, from_account_code: 'HDFC-CA',
  from_account_name: 'HDFC Current', from_kind: 'BANK', to_account_code: 'PETTY', to_account_name: 'Petty Cash', to_kind: 'CASH', charges_account_code: null, charges_account_name: null,
  created_by_name: 'Smoke Tester', posted_at: null, ...t })
const bkLedger = () => BK.matched ? [] : [
  { line_id: 'gl1', voucher_id: 'av-ctr', voucher_number: 'CTR/26-27/000002', date: TODAY, voucher_type: 'CTR', source_type: 'BANK_TRANSFER', is_reversal: false, counterparty: 'SBI Current',
    narration: 'Transfer out', reference: 'NEFT-SBI', payment_method: 'TRANSFER', amount: '-1000.00', matched: '0', remaining: '-1000.00', state: 'UNMATCHED' },
  { line_id: 'gl2', voucher_id: 'av-ctr', voucher_number: 'CTR/26-27/000002', date: TODAY, voucher_type: 'CTR', source_type: 'BANK_TRANSFER', is_reversal: false, counterparty: 'Bank Charges',
    narration: 'Transfer charges', reference: 'NEFT-SBI', payment_method: 'TRANSFER', amount: '-25.00', matched: '0', remaining: '-25.00', state: 'UNMATCHED' }]
const bkStatement = () => [
  ...(BK.matched ? [] : [{ line_id: 'st1', date: TODAY, value_date: TODAY, description: 'NEFT-SBI INCL CHG', reference: null, bank_txn_id: null, amount: '-1025.00', running_balance: '193975.00',
    category: 'OTHER', adjustment_voucher_id: null, matched: '0', remaining: '-1025.00', state: 'UNMATCHED' }]),
  ...(BK.adjusted ? [] : [{ line_id: 'st2', date: TODAY, value_date: TODAY, description: 'SMS CHARGES QTR', reference: null, bank_txn_id: null, amount: '-59.00', running_balance: '193916.00',
    category: 'CHARGES', adjustment_voucher_id: null, matched: '0', remaining: '-59.00', state: 'UNMATCHED' }])]
const accDenied = (perm) => ({ code: '42501', message: `You are not allowed to perform this action (requires ${perm}).` })
const accHasAny = (...perms) => perms.some((p) => has(p))
const stamp = { created_by: null, updated_by: null, created_at: NOW, updated_at: NOW }
const warehouses = [{ id: 'w1', company_id: COMPANY_ID, warehouse_code: 'MAIN', warehouse_name: 'Mock main store', address: null, status: 'ACTIVE', is_default: true, ...stamp }]
const locations = [
  { id: 'l1', company_id: COMPANY_ID, warehouse_id: 'w1', parent_location_id: null, location_code: 'GENERAL', location_name: 'General area', location_type: 'GENERAL', is_default: true, status: 'ACTIVE', ...stamp },
  { id: 'l2', company_id: COMPANY_ID, warehouse_id: 'w1', parent_location_id: null, location_code: 'BIN-1', location_name: 'Bin 1', location_type: 'BIN', is_default: false, status: 'ACTIVE', ...stamp },
]
const detail = (id, source, onHand, reserved) => ({
  balance_id: id, company_id: COMPANY_ID, product_id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', barcode: '8901234567890', category_id: 'c2',
  category_name: 'Water Closets / Toilets', product_type: 'FINISHED_GOOD', default_source_type: 'IN_HOUSE', base_unit: 'PCS', reorder_level: 10,
  product_status: 'ACTIVE', product_archived: false, batch_id: `lot-${source}`, batch_number: null, is_system_lot: true, source_type: source,
  manufacturing_date: null, expiry_date: null, warehouse_id: 'w1', warehouse_code: 'MAIN', warehouse_name: 'Mock main store', warehouse_status: 'ACTIVE',
  location_id: 'l1', location_code: 'GENERAL', location_name: 'General area', location_status: 'ACTIVE', on_hand: onHand, reserved, available: onHand - reserved, last_movement_at: NOW,
})
const tables = {
  warehouses,
  inventory_locations: locations,
  inventory_stock_detail: [detail('b1', 'IN_HOUSE', 100, 10), detail('b2', 'OUTSOURCED', 40, 0)],
  inventory_balances: [{ location_id: 'l1', on_hand: 140, reserved: 10 }],
  inventory_product_stock: [{
    product_id: 'p1', company_id: COMPANY_ID, sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', barcode: '8901234567890', brand: null, model_number: null, category_id: 'c2',
    category_name: 'Water Closets / Toilets', product_type: 'FINISHED_GOOD', default_source_type: 'IN_HOUSE', base_unit: 'PCS', reorder_level: 10, product_status: 'ACTIVE',
    archived_at: null, track_batches: false, on_hand: 140, reserved: 10, available: 130, in_house_on_hand: 100, outsourced_on_hand: 40, unknown_source_on_hand: 0,
    last_movement_at: NOW, has_history: true, stock_status: 'HEALTHY',
  }],
  inventory_transaction_list: [{
    id: 't1', company_id: COMPANY_ID, transaction_number: 'TXN-000001', transaction_type: 'OPENING_STOCK', direction: 1, product_id: 'p1', batch_id: 'lot-IN_HOUSE',
    warehouse_id: 'w1', location_id: 'l1', quantity: 100, unit: 'PCS', source_type: 'IN_HOUSE', unit_cost: 450, reference_type: 'OPENING_STOCK', reference_number: 'OS-000001',
    reference_id: null, reason: 'Opening stock OS-000001', notes: null, transaction_date: NOW, status: 'POSTED', document_type: 'OPENING', document_id: 'ob1',
    transfer_group_id: null, reversal_of_transaction_id: null, created_by: MANAGER_ID, approved_by: VIEWER_ID, created_at: NOW, sku: 'MOCK-WC-1', product_name: 'Mock Closet 1',
    batch_number: null, warehouse_code: 'MAIN', warehouse_name: 'Mock main store', location_code: 'GENERAL', location_name: 'General area', quantity_in: 100, quantity_out: null,
    counterpart_location_id: null, counterpart_location_code: null, counterpart_warehouse_code: null, reversed_by_transaction_id: null, reversed_by_number: null, reversal_of_number: null,
  }],
  inventory_transactions: [{ created_by: MANAGER_ID }],
  stock_reservations: [],
  inventory_opening_batches: [{ id: 'ob2', company_id: COMPANY_ID, document_number: 'OS-000002', source: 'MANUAL', file_name: null, status: 'PENDING_APPROVAL', line_count: 1,
    notes: null, requested_by: VIEWER_ID, requested_at: NOW, reviewed_by: null, reviewed_at: null, review_note: null, posted_at: null, updated_at: NOW }],
  inventory_opening_lines: [],
  inventory_adjustments: [{ id: 'a1', company_id: COMPANY_ID, adjustment_number: 'ADJ-000001', adjustment_type: 'QUANTITY', product_id: 'p1', batch_id: 'lot-IN_HOUSE', batch_number: null,
    warehouse_id: 'w1', location_id: 'l1', source_type: 'IN_HOUSE', target_source_type: null, system_quantity: 100, counted_quantity: 98, correction_quantity: null, difference: -2,
    unit_cost: null, reason_code: 'DAMAGE', notes: 'Broken', reference: null, effective_date: TODAY, status: 'PENDING_APPROVAL', requested_by: MANAGER_ID, requested_at: NOW,
    submitted_at: NOW, reviewed_by: null, reviewed_at: null, review_note: null, posted_at: null, updated_at: NOW, reason_label: 'Damaged' }],
  inventory_counts: [],
  inventory_count_lines: [],
  inventory_alerts: [{ id: 'al1', company_id: COMPANY_ID, alert_key: 'LOW_STOCK:p1', alert_type: 'LOW_STOCK', severity: 'WARNING', product_id: 'p1', batch_id: null, warehouse_id: null,
    location_id: null, details: { sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', on_hand: 12, reserved: 4, available: 8, reorder_level: 10 }, status: 'OPEN',
    first_detected_at: NOW, last_detected_at: NOW, acknowledged_by: null, acknowledged_at: null, acknowledgement_note: null, resolved_at: null, notified_at: null }],
  inventory_batches: [{ id: 'lot-g1', company_id: COMPANY_ID, product_id: 'p4', batch_number: 'G-1', is_system_lot: false, source_type: 'OUTSOURCED', supplier_id: null,
    manufacturing_date: null, expiry_date: null, unit_cost: null, currency_code: 'INR', reference_type: null, reference_id: null, received_warehouse_id: 'w1',
    received_location_id: 'l1', status: 'ACTIVE', created_by: MANAGER_ID, created_at: NOW }],
}

// --- Production / outsourcing mock data (Phase 5) ---------------------------
locations.push(
  { id: 'l3', company_id: COMPANY_ID, warehouse_id: 'w1', parent_location_id: null, location_code: 'JOB-1', location_name: 'At Mock Processor', location_type: 'AREA', is_default: false, status: 'ACTIVE', stock_usage: 'EXTERNAL_PROCESSING', external_holder: 'Mock Processor', ...stamp },
  { id: 'l4', company_id: COMPANY_ID, warehouse_id: 'w1', parent_location_id: null, location_code: 'REJECT', location_name: 'Rejected bay', location_type: 'AREA', is_default: false, status: 'ACTIVE', stock_usage: 'REJECTED', external_holder: null, ...stamp },
)
const matLot = (id, productId, sku, name, batchId, batchNumber, locationId, locationCode, onHand, available) => ({
  ...detail(id, 'OUTSOURCED', onHand, 0), product_id: productId, sku, product_name: name, barcode: null, category_id: null, category_name: null, product_type: 'RAW_MATERIAL',
  base_unit: 'KG', reorder_level: null, batch_id: batchId, batch_number: batchNumber, is_system_lot: !batchNumber, location_id: locationId, location_code: locationCode, available,
})
tables.inventory_stock_detail.push(
  matLot('b3', 'p4', 'MOCK-GLZ', 'Mock glaze', 'lot-g1', 'G-1', 'l1', 'GENERAL', 20, 20),
  matLot('b4', 'p3', 'MOCK-CLAY', 'Mock ceramic body', 'lot-clay', null, 'l1', 'GENERAL', 75, 75),
  matLot('b5', 'p3', 'MOCK-CLAY', 'Mock ceramic body', 'lot-clay', null, 'l3', 'JOB-1', 20, 0),
)
const bomRow = (id, version, status, createdBy) => ({
  id, company_id: COMPANY_ID, bom_code: 'BOM-000001', finished_product_id: 'p1', version, status, effective_from: '2026-01-01', effective_to: null, output_quantity: 1,
  output_unit: 'PCS', notes: null, created_by: createdBy, submitted_by: createdBy, submitted_at: NOW, approved_by: status === 'APPROVED' ? MANAGER_ID : null,
  approved_at: status === 'APPROVED' ? NOW : null, review_note: null, archived_by: null, archived_at: null, created_at: NOW, updated_at: NOW,
  sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', product_type: 'FINISHED_GOOD', product_status: 'ACTIVE', item_count: 2,
})
const bomItem = (id, bomId, line, productId, sku, name, qty, wastage) => ({
  id, company_id: COMPANY_ID, bom_id: bomId, line_no: line, component_product_id: productId, quantity_required: qty, unit: 'KG', wastage_percentage: wastage, notes: null,
  created_at: NOW, sku, product_name: name, product_type: 'RAW_MATERIAL', inventory_unit: 'KG', product_status: 'ACTIVE', product_archived: false, standard_cost: null,
})
const orderRow = (id, number, status, createdBy, extra = {}) => ({
  id, company_id: COMPANY_ID, production_order_number: number, finished_product_id: 'p1', bom_id: 'bom1', bom_code: 'BOM-000001', bom_version: 1, unit: 'PCS',
  planned_quantity: 10, completed_quantity: 0, rejected_quantity: 0, scrap_quantity: 0, actual_quantity: 0, status, status_before_hold: null, priority: 'HIGH',
  source_warehouse_id: 'w1', destination_warehouse_id: 'w1', planned_start_date: TODAY, target_completion_date: TODAY, actual_start_date: null, actual_completion_date: null,
  notes: null, review_note: null, hold_reason: null, cancel_reason: null, completion_note: null, created_by: createdBy, submitted_by: createdBy, submitted_at: NOW,
  approved_by: null, approved_at: null, started_by: null, completed_by: null, completed_at: null, cancelled_by: null, cancelled_at: null, created_at: NOW, updated_at: NOW,
  sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', source_warehouse_code: 'MAIN', destination_warehouse_code: 'MAIN', material_lines: 2, material_lines_issued: 0,
  material_status: 'NOT_ISSUED', is_overdue: false, ...extra,
})
Object.assign(tables, {
  bom_list: [bomRow('bom1', 1, 'APPROVED', VIEWER_ID), bomRow('bom2', 2, 'PENDING_APPROVAL', MANAGER_ID)],
  bom_item_list: [bomItem('bi1', 'bom1', 1, 'p3', 'MOCK-CLAY', 'Mock ceramic body', 2.5, 0), bomItem('bi2', 'bom1', 2, 'p4', 'MOCK-GLZ', 'Mock glaze', 0.2, 10),
    bomItem('bi3', 'bom2', 1, 'p3', 'MOCK-CLAY', 'Mock ceramic body', 2.4, 0), bomItem('bi4', 'bom2', 2, 'p4', 'MOCK-GLZ', 'Mock glaze', 0.2, 10)],
  bom_templates: [],
  bom_template_items: [],
  // bom_list plus the finished product's planning fields (migration 20261114090000).
  bom_list_v2: [bomRow('bom1', 1, 'APPROVED', VIEWER_ID), bomRow('bom2', 2, 'PENDING_APPROVAL', MANAGER_ID)]
    .map((b) => ({ ...b, tax_rate: 18, lead_time_days: 12, group_head: 'Sanitaryware', minimum_cover_days: 15, ean: '4006381333931' })),
  // BOM cost columns (migration 20261208090000): bom1 approved and costed, bom2 pending (no approved cost).
  bom_cost_list: [
    { bom_id: 'bom1', company_id: COMPANY_ID, finished_product_id: 'p1', status: 'APPROVED', bom_unit_cost: 1320.69, bom_cost_status: 'COMPLETE', known_unit_cost: 1320.69,
      line_count: 2, missing_count: 0, cost_calculated_at: '2026-11-12T09:30:00Z', product_master_cost: 850, product_master_cost_source: 'PURCHASE', cost_difference: 470.69 },
    { bom_id: 'bom2', company_id: COMPANY_ID, finished_product_id: 'p1', status: 'PENDING_APPROVAL', bom_unit_cost: null, bom_cost_status: 'NOT_APPROVED', known_unit_cost: null,
      line_count: 2, missing_count: null, cost_calculated_at: null, product_master_cost: 850, product_master_cost_source: 'PURCHASE', cost_difference: null },
  ],
  product_cost_history: [
    { id: 'pch2', company_id: COMPANY_ID, product_id: 'p1', previous_cost: 900, new_cost: 850, previous_source: 'GRN', new_source: 'GRN', event: 'GRN_REVERSED',
      bom_id: null, bom_code: null, bom_version: null, goods_receipt_id: 'gr9', receipt_number: 'GRN-000009', purchase_event_id: null,
      reason: 'GRN GRN-000010 reversed', created_by: MANAGER_ID, created_at: '2026-11-12T09:00:00Z' },
    { id: 'pch1', company_id: COMPANY_ID, product_id: 'p1', previous_cost: 1200, new_cost: 900, previous_source: 'MANUAL', new_source: 'GRN', event: 'GRN_POSTED',
      bom_id: null, bom_code: null, bom_version: null, goods_receipt_id: 'gr10', receipt_number: 'GRN-000010', purchase_event_id: null,
      reason: 'GRN GRN-000010 posted', created_by: MANAGER_ID, created_at: '2026-11-11T09:00:00Z' },
  ],
  production_order_list: [
    orderRow('po1', 'PRD-000001', 'IN_PROGRESS', VIEWER_ID, { completed_quantity: 4, actual_quantity: 4, actual_start_date: TODAY, approved_by: MANAGER_ID, material_lines_issued: 1, material_status: 'PARTIALLY_ISSUED' }),
    orderRow('po2', 'PRD-000002', 'PENDING_APPROVAL', MANAGER_ID),
  ],
  production_order_events: [{ id: 'ev1', company_id: COMPANY_ID, production_order_id: 'po1', event_type: 'CREATED', from_status: null, to_status: 'DRAFT', note: null,
    details: {}, actor_user_id: VIEWER_ID, created_at: NOW }],
  production_consumption_list: [{ id: 'pc1', company_id: COMPANY_ID, production_order_id: 'po1', order_material_id: 'pm1', component_product_id: 'p3', batch_id: 'lot-clay',
    warehouse_id: 'w1', location_id: 'l1', planned_quantity: 25, actual_quantity: 25, unit: 'KG', reserved_quantity_used: 25, inventory_transaction_id: 't20', consumption_date: TODAY,
    over_issue_reason: null, notes: null, status: 'POSTED', reversal_transaction_ids: null, reversal_reason: null, reversed_by: null, reversed_at: null, recorded_by: MANAGER_ID,
    created_at: NOW, production_order_number: 'PRD-000001', order_status: 'IN_PROGRESS', sku: 'MOCK-CLAY', product_name: 'Mock ceramic body', batch_number: null,
    source_type: 'OUTSOURCED', warehouse_code: 'MAIN', location_code: 'GENERAL', transaction_number: 'TXN-000020' }],
  production_output_list: [{ id: 'fr1', company_id: COMPANY_ID, receipt_number: 'FGR-000001', production_order_id: 'po1', product_id: 'p1', batch_id: 'lot-IN_HOUSE', good_quantity: 4,
    rejected_quantity: 0, scrap_quantity: 0, unit: 'PCS', good_location_id: 'l1', rejected_location_id: null, good_transaction_id: 't21', rejected_transaction_id: null,
    production_date: TODAY, unit_cost: null, quality_status: 'ACCEPTED', rejection_reason: null, over_production_reason: null, notes: null, status: 'POSTED',
    reversal_transaction_ids: null, reversal_reason: null, reversed_by: null, reversed_at: null, created_by: MANAGER_ID, created_at: NOW, production_order_number: 'PRD-000001',
    order_status: 'IN_PROGRESS', order_planned_quantity: 10, sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', batch_number: null, good_location_code: 'GENERAL',
    good_warehouse_code: 'MAIN', rejected_location_code: null, good_transaction_number: 'TXN-000021', rejected_transaction_number: null }],
  outsourcing_order_list: [{ id: 'oo1', company_id: COMPANY_ID, outsourcing_order_number: 'OUT-000001', order_type: 'OUTSOURCED_PROCESSING', supplier_id: null,
    supplier_name: 'Mock Processor', supplier_reference: 'JW-1', product_id: 'p1', bom_id: null, bom_code: null, bom_version: null, unit: 'PCS', ordered_quantity: 10,
    received_quantity: 0, accepted_quantity: 0, rejected_quantity: 0, status: 'MATERIALS_DISPATCHED', status_before_hold: null, dispatch_date: TODAY, expected_return_date: TODAY,
    destination_warehouse_id: 'w1', external_location_id: 'l3', reference_number: null, unit_cost: 30, currency_code: 'INR', notes: null, review_note: null, hold_reason: null,
    cancel_reason: null, completion_note: null, created_by: VIEWER_ID, submitted_by: VIEWER_ID, submitted_at: NOW, approved_by: MANAGER_ID, approved_at: NOW, completed_by: null,
    completed_at: null, cancelled_by: null, cancelled_at: null, created_at: NOW, updated_at: NOW, sku: 'MOCK-WC-1', product_name: 'Mock Closet 1',
    destination_warehouse_code: 'MAIN', external_location_code: 'JOB-1', external_holder: 'Mock Processor', pending_quantity: 10, material_lines: 1, material_lines_held: 1 }],
  outsourcing_material_list: [{ id: 'om1', company_id: COMPANY_ID, outsourcing_order_id: 'oo1', line_no: 1, component_product_id: 'p3', unit: 'KG', quantity_per_unit: null,
    planned_quantity: 20, dispatched_quantity: 20, returned_quantity: 0, consumed_quantity: 0, sku: 'MOCK-CLAY', product_name: 'Mock ceramic body', inventory_unit: 'KG', held_quantity: 20 }],
  outsourcing_receipt_list: [],
  outsourcing_movement_list: [],
  outsourcing_order_events: [],
})
// --- Customer PO mock data (Phase 6) ----------------------------------------
const poLine = (id, no, status, extra = {}) => ({
  id, company_id: COMPANY_ID, purchase_order_id: 'cpo1', line_no: no, source_row_number: no + 1, uploaded_sku: null, uploaded_customer_sku: null,
  uploaded_barcode: null, uploaded_description: null, uploaded_quantity: 5, uploaded_unit: 'PCS', product_id: null, quantity_ordered: 5, unit: 'PCS',
  unit_price: 950, currency: 'INR', tax_rate: 18, hsn_code: null, remarks: null, line_status: status, status_reason: null, matching_method: null, match_note: null,
  candidate_product_ids: [], matched_by: null, matched_at: null, flagged_for_new_product: false, duplicate_of_line_id: null, duplicate_confirmed: false,
  quantity_dispatched: 0, shortage_status: 'OPEN', shortage_priority: 'NORMAL', shortage_owner: null, created_at: NOW, updated_at: NOW,
  po_reference: 'CPO-000001', customer_po_number: 'ACME-77', revision: 1, customer_name_snapshot: 'Acme Ltd', po_status: 'PRODUCT_MATCHING_REQUIRED', is_current: true,
  sku: null, product_name: null, base_unit: null, product_status: null, category_name: null, allocated_open: 0, ...extra,
})
Object.assign(tables, {
  customers: [{ id: 'cu1', company_id: COMPANY_ID, customer_code: 'ACME', customer_name: 'Acme Ltd', contact_email: null, status: 'ACTIVE', notes: null, ...stamp }],
  customer_po_list: [{
    id: 'cpo1', company_id: COMPANY_ID, po_reference: 'CPO-000001', customer_id: 'cu1', customer_name_snapshot: 'Acme Ltd', customer_key: 'C:cu1', customer_po_number: 'ACME-77',
    revision: 1, previous_revision_id: null, is_current: true, po_date: TODAY, required_delivery_date: TODAY, currency: 'INR', fulfilment_warehouse_id: null,
    status: 'READY_FOR_ALLOCATION', status_before_hold: null, hold_reason: null, cancel_reason: null, source_filename: 'acme-77.xlsx', file_hash: null, import_batch_id: null,
    notes: null, uploaded_by: MANAGER_ID, reviewed_by: null, cancelled_by: null, cancelled_at: null, last_analysis_at: null, created_at: NOW, updated_at: NOW,
    customer_code: 'ACME', fulfilment_warehouse_code: null, line_count: 2, unmatched_lines: 1, review_lines: 0, unit_totals: [{ unit: 'PCS', ordered: 5, dispatched: 0, allocated: 0 }],
  }],
  customer_po_line_list: [
    poLine('cl1', 1, 'MATCHED', { uploaded_sku: 'MOCK-WC-1', product_id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', base_unit: 'PCS', matching_method: 'SKU', match_note: 'Exact internal SKU' }),
    poLine('cl2', 2, 'UNMATCHED', { uploaded_sku: 'ZZ-404', uploaded_description: 'Unknown closet', match_note: 'No product with this code.' }),
  ],
  customer_po_allocation_list: [],
  customer_po_events: [],
  customer_po_allocation_runs: [],
  customer_po_analysis_snapshots: [],
  customer_po_import_batches: [],
  customer_po_shortage_notes: [],
})
const PO_ANALYSIS_LINE = {
  line_id: 'cl1', purchase_order_id: 'cpo1', line_no: 1, source_row_number: 2, uploaded_sku: 'MOCK-WC-1', uploaded_customer_sku: null, uploaded_description: null,
  product_id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', category_name: 'Water Closets / Toilets', base_unit: 'PCS', line_unit: 'PCS', default_source_type: 'IN_HOUSE',
  reorder_level: 10, line_status: 'MATCHED', status_reason: null, quantity_ordered: 5, quantity_dispatched: 0, allocated_open: 0, remaining_need: 5, on_hand: 140, reserved: 10,
  available: 130, in_house_on_hand: 100, in_house_reserved: 10, in_house_available: 90, outsourced_on_hand: 40, outsourced_reserved: 0, outsourced_available: 40,
  unknown_on_hand: 0, ineligible_on_hand: 0, other_warehouse_available: 0, available_for_line: 5, shortage_before: 0, shortage_after: 5,
  availability_status: 'FULLY_AVAILABLE', review_warning: null, shortage_status: 'OPEN', shortage_priority: 'NORMAL', shortage_owner: null,
}
const PO_DASHBOARD = {
  has_records: true, total_received: 1, pending_review: 0, ready_for_fulfilment: 1, partially_available: 0, with_shortages: 0, fully_allocated: 0,
  units: [{ unit: 'PCS', ordered: 5, need: 5, available: 130, reserved_for_pos: 0, shortage: 0, in_house_available: 90, outsourced_available: 40, unknown_on_hand: 0 }],
  by_status: [{ status: 'READY_FOR_ALLOCATION', count: 1 }], top_products: [{ sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', ordered: 5, available: 130, shortage: 0 }],
  shortage_by_category: [], received_over_time: [{ bucket: TODAY, count: 1 }], timezone: 'Asia/Kolkata', as_of: NOW,
}

// --- Sales order / fulfilment mock data (Phase 7) ---------------------------
// V2 Stage 5: fulfilment summary of so1 (sales_order_v2_summary)
const SO_V2 = {
  sales_order_id: 'so1', sales_order_number: 'SO-000001', status: 'STOCK_SHORTAGE', order_status: 'IN_FULFILMENT', customer_id: 'cu1', customer_name: 'Acme Ltd',
  customer_gstin: null, grand_total: 118000,
  lines: [{ line_id: 'sol1', line_no: 1, product_id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', description: null, unit: 'PCS', product_type: 'FINISHED_GOOD',
    ordered: 100, cancelled: 0, dispatched: 30, pending: 70, reserved: 40, on_pick_list: 0, available_for_dispatch: 40, production_open: 20, produced: 0, to_produce: 10,
    production_orders: [{ id: 'po1', production_order_number: 'PRD-000001', status: 'IN_PROGRESS', planned_quantity: 20, completed_quantity: 0 }],
    unit_price: 1000, discount_percent: null, discount_amount: 0, gst_rate: 18, taxable_value: 100000, gst_amount: 18000, line_total: 118000,
    bom: { id: 'bom1', bom_code: 'BOM-000001', version: 1 }, materials: [], material_short: true }],
  shortages: [{ product_id: 'p3', sku: 'MOCK-CLAY', product_name: 'Mock ceramic body', product_type: 'RAW_MATERIAL', unit: 'KG', required: 25, reserved: 10, available: 0,
    shortage: 15, recommended_purchase: 15, preferred_supplier_id: 'sup1', preferred_supplier_name: 'Shree Clay Works Pvt Ltd', hsn_code: '2508', gst_rate: 5, standard_cost: 12 }],
  warnings: ['MOCK-WC-1: 10 PCS to produce.', 'MOCK-CLAY: short by 15 KG. Purchase 15 KG.'],
  dispatches: [{ fulfilment_id: 'f9', fulfilment_number: 'FUL-000009', status: 'DISPATCHED', dispatched_at: '2026-10-30T09:00:00Z', created_at: '2026-10-30T09:00:00Z',
    vehicle_number: 'MH12AB1234', lr_number: null, cancel_reason: null, invoiced: false, lines: [{ sku: 'MOCK-WC-1', unit: 'PCS', quantity: 30, quantity_to_pick: 30, transaction_number: 'TXN-000070' }] }],
  history: [{ id: 'sev1', event_type: 'EDITED', from_status: null, to_status: null, note: 'Customer revised the PO', details: { changes: [{ line_no: 1, field: 'quantity', old: 80, new: 100 }] },
    created_at: '2026-10-30T09:00:00Z', actor_user_id: null }],
}
const soRow = (id, number, status, extra = {}) => ({
  id, company_id: COMPANY_ID, sales_order_number: number, source: 'CUSTOMER_PO', customer_id: 'cu1', customer_key: 'C:cu1', customer_name_snapshot: 'Acme Ltd',
  customer_purchase_order_id: 'cpo1', customer_po_number: 'ACME-77', source_po_reference: 'CPO-000001', source_filename: 'acme-77.xlsx', order_date: TODAY,
  requested_delivery_date: TODAY, shipping_address_snapshot: 'Plot 4, Mock Estate', billing_address_snapshot: null, order_status: status, status_before_hold: null,
  fulfilment_status: 'IN_PROGRESS', priority: 'HIGH', warehouse_id: 'w1', currency: 'INR', customer_reference: null, internal_notes: null, hold_reason: null, cancel_reason: null,
  created_by: MANAGER_ID, confirmed_by: MANAGER_ID, confirmed_at: NOW, cancelled_by: null, cancelled_at: null, created_at: NOW, updated_at: NOW,
  customer_code: 'ACME', warehouse_code: 'MAIN', line_count: 1, unit_totals: [{ unit: 'PCS', ordered: 5, cancelled: 0, dispatched: 2, delivered: 0, returned: 0, remaining: 3, reserved: 3 }],
  fulfilment_count: 3, last_dispatch_at: NOW, has_exception: true, ...extra,
})
const fulRow = (id, number, status, extra = {}) => ({
  id, company_id: COMPANY_ID, fulfilment_number: number, sales_order_id: 'so1', warehouse_id: 'w1', fulfilment_status: status, planned_dispatch_date: null,
  expected_delivery_date: TODAY, actual_dispatch_at: null, carrier_name: null, transport_mode: null, vehicle_number: null, lr_number: null, tracking_number: null,
  eway_bill_number: null, delivery_reference: null, document_references: null, dispatch_notes: null, packing_notes: null, notes: null, reopen_reason: null, exception_reason: null,
  cancel_reason: null, created_by: MANAGER_ID, picked_at: null, packed_at: null, ready_at: null, dispatched_by: null, delivered_at: null, cancelled_by: null, cancelled_at: null,
  created_at: NOW, updated_at: NOW, sales_order_number: 'SO-000001', customer_name_snapshot: 'Acme Ltd', customer_id: 'cu1', customer_key: 'C:cu1', customer_po_number: 'ACME-77',
  order_status: 'IN_FULFILMENT', priority: 'HIGH', order_requested_date: TODAY, shipping_address_snapshot: 'Plot 4, Mock Estate', warehouse_code: 'MAIN', warehouse_name: 'Mock main store',
  line_count: 1, to_pick: 2, picked: 0, packed: 0, damaged: 0, dispatched: 0, delivered: 0, units: 'PCS', pick_exceptions: 0, pack_exceptions: 0, is_overdue: false,
  delivery_days_late: null, last_event_type: null, last_event_at: null, last_event_location: null, ...extra,
})
const fulLine = (id, fulfilmentId, number, status, extra = {}) => ({
  id, company_id: COMPANY_ID, fulfilment_id: fulfilmentId, line_no: 1, sales_order_line_id: 'sol1', product_id: 'p1', reservation_id: 'r1', batch_id: 'lot-IN_HOUSE', location_id: 'l1',
  quantity_to_pick: 2, quantity_picked: 0, quantity_packed: 0, quantity_damaged: 0, quantity_dispatched: 0, quantity_delivered: 0, pick_exception: null, pack_exception: null,
  picked_by: null, picked_at: null, packed_by: null, packed_at: null, issue_transaction_id: null, created_at: NOW, updated_at: NOW, fulfilment_number: number, fulfilment_status: status,
  sales_order_id: 'so1', warehouse_id: 'w1', sales_order_number: 'SO-000001', customer_name_snapshot: 'Acme Ltd', order_line_no: 1, quantity_ordered: 5, quantity_cancelled: 0,
  order_line_dispatched: 2, order_line_remaining: 3, sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', barcode: '8901234567890', unit: 'PCS', batch_number: null, expiry_date: null,
  source_type: 'IN_HOUSE', warehouse_code: 'MAIN', location_code: 'GENERAL', reservation_number: 'RES-000050', reservation_remaining: 3, stock_problem: null, issue_transaction_number: null, ...extra,
})
Object.assign(tables, {
  sales_order_list: [soRow('so1', 'SO-000001', 'IN_FULFILMENT', { customer_gstin_snapshot: null, payment_terms: '30 days', delivery_instructions: null, freight_amount: 0,
      other_charges_amount: 0, charges_gst_rate: 18, tax_treatment: 'INTRA_STATE', gross_total: 100000, discount_total: 0, taxable_total: 100000, cgst_total: 9000, sgst_total: 9000,
      igst_total: 0, grand_total: 118000 }),
    soRow('so2', 'SO-000002', 'PENDING_CONFIRMATION', { source: 'MANUAL', customer_purchase_order_id: null, customer_po_number: 'TEL-5', source_po_reference: null, source_filename: null,
      fulfilment_status: 'NOT_STARTED', unit_totals: [{ unit: 'PCS', ordered: 1, cancelled: 0, dispatched: 0, delivered: 0, returned: 0, remaining: 1, reserved: 0 }], fulfilment_count: 0, has_exception: false })],
  sales_order_line_list: [{
    id: 'sol1', company_id: COMPANY_ID, sales_order_id: 'so1', line_no: 1, customer_purchase_order_line_id: 'cl1', product_id: 'p1', sku_snapshot: 'MOCK-WC-1', product_name_snapshot: 'Mock Closet 1',
    customer_sku_snapshot: null, quantity_ordered: 5, quantity_cancelled: 0, quantity_dispatched: 2, quantity_delivered: 0, quantity_returned: 0, unit: 'PCS', unit_price_snapshot: 950,
    currency: 'INR', requested_delivery_date: TODAY, line_status: 'PARTIALLY_FULFILLED', backorder_reason: null, expected_fulfilment_date: null, notes: null, created_at: NOW, updated_at: NOW,
    sales_order_number: 'SO-000001', order_status: 'IN_FULFILMENT', customer_name_snapshot: 'Acme Ltd', customer_id: 'cu1', customer_po_number: 'ACME-77', order_date: TODAY,
    order_requested_date: TODAY, priority: 'HIGH', order_warehouse_id: 'w1', barcode: '8901234567890', base_unit: 'PCS', product_status: 'ACTIVE', default_source_type: 'IN_HOUSE',
    po_line_no: 1, quantity_effective: 5, quantity_remaining: 3, quantity_reserved: 3, quantity_planned: 3, quantity_picked: 0, quantity_packed: 2, quantity_unreserved: 0, available_now: 85,
  }],
  sales_order_reservation_list: [{
    id: 'r1', company_id: COMPANY_ID, reservation_number: 'RES-000050', reservation_status: 'PARTIALLY_FULFILLED', quantity: 5, fulfilled_quantity: 2, released_quantity: 0, remaining: 3,
    planned: 3, reserved_at: NOW, notes: null, batch_id: 'lot-IN_HOUSE', location_id: 'l1', warehouse_id: 'w1', product_id: 'p1', sales_order_line_id: 'sol1', line_no: 1,
    sales_order_id: 'so1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', sales_order_number: 'SO-000001', customer_name_snapshot: 'Acme Ltd', batch_number: null,
    expiry_date: null, source_type: 'IN_HOUSE', batch_status: 'ACTIVE', warehouse_code: 'MAIN', location_code: 'GENERAL', stock_usage: 'STORAGE', location_status: 'ACTIVE',
  }],
  sales_order_events: [{ id: 'se1', company_id: COMPANY_ID, sales_order_id: 'so1', fulfilment_id: null, return_id: null, line_id: null, event_type: 'CREATED_FROM_PO', from_status: null,
    to_status: 'PENDING_CONFIRMATION', note: null, details: { po_reference: 'CPO-000001' }, actor_user_id: MANAGER_ID, created_at: NOW }],
  fulfilment_list: [
    fulRow('f1', 'FUL-000001', 'PENDING'),
    fulRow('f2', 'FUL-000002', 'READY_FOR_DISPATCH', { picked: 1, packed: 1, to_pick: 1 }),
    fulRow('f3', 'FUL-000003', 'DISPATCHED', { actual_dispatch_at: NOW, carrier_name: 'Mock Freight', tracking_number: 'TRK-9', dispatched: 2, picked: 2, packed: 2, is_overdue: true,
      last_event_type: 'DISPATCHED', last_event_at: NOW }),
  ],
  fulfilment_line_list: [
    fulLine('fl1', 'f1', 'FUL-000001', 'PENDING'),
    fulLine('fl2', 'f2', 'FUL-000002', 'READY_FOR_DISPATCH', { quantity_to_pick: 1, quantity_picked: 1, quantity_packed: 1 }),
    fulLine('fl3', 'f3', 'FUL-000003', 'DISPATCHED', { quantity_picked: 2, quantity_packed: 2, quantity_dispatched: 2, issue_transaction_number: 'TXN-000040' }),
  ],
  delivery_events: [{ id: 'de1', company_id: COMPANY_ID, fulfilment_id: 'f3', event_type: 'DISPATCHED', event_at: NOW, location: null, description: 'Dispatch posted: TXN-000040',
    reference_number: 'TRK-9', failure_reason: null, delivered_quantities: [], source: 'SYSTEM', verified: false, recorded_by: MANAGER_ID, created_at: NOW }],
  customer_return_list: [{
    id: 'ret1', company_id: COMPANY_ID, return_number: 'RET-000001', sales_order_id: 'so1', fulfilment_id: 'f3', customer_id: 'cu1', customer_name_snapshot: 'Acme Ltd', return_date: TODAY,
    reason_code: 'DEFECTIVE', reason_note: 'cracked', customer_reference: null, status: 'REQUESTED', receipt_location_id: null, notes: null, requested_by: MANAGER_ID, authorized_by: null,
    authorized_at: null, decision_note: null, received_by: null, received_at: null, inspected_by: null, inspected_at: null, inspection_note: null, closed_by: null, closed_at: null,
    created_at: NOW, updated_at: NOW, sales_order_number: 'SO-000001', customer_po_number: 'ACME-77', fulfilment_number: 'FUL-000003', receipt_location_code: null, line_count: 1,
    requested: 1, received: 0, units: 'PCS', restocked: 0, pending_dispositions: 0,
  }],
  customer_return_line_list: [{
    id: 'rl1', company_id: COMPANY_ID, return_id: 'ret1', line_no: 1, sales_order_line_id: 'sol1', fulfilment_line_id: 'fl3', product_id: 'p1', batch_id: 'lot-IN_HOUSE',
    quantity_requested: 1, quantity_received: 0, disposition: 'PENDING_REVIEW', inspection_note: null, receipt_transaction_id: null, disposition_posted: false,
    disposition_transaction_ids: [], created_at: NOW, updated_at: NOW, return_number: 'RET-000001', return_status: 'REQUESTED', sales_order_id: 'so1', reason_code: 'DEFECTIVE',
    sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', batch_number: null, fulfilment_number: 'FUL-000003', fulfilment_line_dispatched: 2, receipt_transaction_number: null,
  }],
})
const SALES_OVERVIEW = {
  has_records: true, total_orders: 2, awaiting_confirmation: 1, ready_for_picking: 1, being_packed: 0, ready_for_dispatch: 1, dispatched: 1, in_transit: 1, delivered: 0,
  partially_fulfilled: 0, with_exceptions: 1, units_awaiting: [{ unit: 'PCS', quantity: 4 }], units_dispatched: [{ unit: 'PCS', quantity: 2 }],
  by_status: [{ status: 'IN_FULFILMENT', count: 1 }, { status: 'PENDING_CONFIRMATION', count: 1 }], created_over_time: [{ bucket: TODAY, count: 2 }],
  ordered_vs_dispatched: [{ sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', ordered: 6, dispatched: 2, remaining: 4 }],
  pending_by_warehouse: [{ warehouse: 'MAIN', unit: 'PCS', reserved: 3, unallocated: 0 }, { warehouse: 'Not allocated', unit: 'PCS', reserved: 0, unallocated: 1 }],
  delivery_performance: { delivered: 0, on_time: 0, late: 0, no_expected_date: 0, average_days_late: null, by_bucket: [] }, overdue_deliveries: 1,
  returns_by_product_reason: [{ sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', reason_code: 'DEFECTIVE', quantity: 1, returns: 1 }], timezone: 'Asia/Kolkata', as_of: NOW,
}

// --- Billing mock data (Phase 8; exists only in this test process) -----------
const BILLING_SETTINGS = {
  company_id: COMPANY_ID, gst_registered: true, seller_pan: null, invoice_prefix: 'INV', credit_note_prefix: 'CN', debit_note_prefix: 'DN', receipt_prefix: 'RCT',
  include_fy_in_number: true, number_padding: 4, fy_start_month: 4, default_payment_terms_days: 30, billing_basis: 'DISPATCH', allow_partial_dispatch_invoicing: false,
  allow_line_discount: false, require_approval: false, round_off_enabled: false, other_charge_enabled: false, other_charge_label: null, other_charge_sac: null,
  other_charge_gst_rate: null, allowed_special_categories: [], payment_methods: ['BANK_TRANSFER', 'UPI', 'CHEQUE'], terms_text: null, footer_text: null, bank_account_name: null,
  bank_name: null, bank_account_number: null, bank_ifsc: null, bank_branch: null, show_bank_details: false, e_invoice_status: 'NOT_CONFIGURED', updated_by: null, updated_at: NOW,
  company: { legal_name: 'Test Co', legal_address: 'Mock Road, Pune', state: 'Maharashtra', gstin: '27AAAAA0000A1Z5', state_code: '27', state_name: 'Maharashtra', currency_code: 'INR' },
  current_financial_year: '2026-27', example_invoice_number: 'INV/26-27/0001', example_credit_note_number: 'CN/26-27/0001', example_receipt_number: 'RCT/26-27/0001',
  // V2 Stage 6
  pricing_mode: 'EXCLUSIVE', rounding_mode: 'NEAREST', gst_rates: [0, 5, 12, 18, 28], freight_sac: '996511', freight_gst_rate: 18, packing_sac: '998540', packing_gst_rate: 18,
  default_invoice_type: 'TAX_INVOICE', invoice_date_format: 'DD-MM-YYYY', default_payment_method: 'BANK_TRANSFER',
  bank_accounts: [{ label: 'HDFC current', bank_name: 'HDFC Bank', account_name: 'Test Co', account_number: '50200012345678', ifsc: 'HDFC0000123' }],
  authorized_signatory: 'Director', invoice_template: 'CLASSIC', show_logo: true,
}
const invRow = (id, number, status, extra = {}) => ({
  id, company_id: COMPANY_ID, invoice_number: number, numbering_scope: null, financial_year: number ? '2026-27' : null, invoice_type: 'TAX_INVOICE', invoice_date: TODAY,
  due_date: TODAY, payment_terms_days: 30, customer_id: 'cu1', customer_code_snapshot: 'ACME', customer_legal_name: 'Acme Ltd', customer_billing_address: 'Plot 4, Mock Estate',
  customer_shipping_address: null, customer_gstin: '27BBBBB0000B1Z5', customer_registration_type: 'REGISTERED', customer_billing_state_code: '27', customer_shipping_state_code: null,
  seller_legal_name: 'Test Co', seller_address: 'Mock Road, Pune', seller_gstin: '27AAAAA0000A1Z5', seller_pan: null, seller_state_code: '27', place_of_supply_state_code: '27',
  supply_category: 'TAXABLE', special_category_reason: null, tax_treatment: 'INTRA_STATE', order_references: 'SO-000001', dispatch_references: 'FUL-000003', currency: 'INR',
  gross_total: 1900, discount_total: 0, taxable_subtotal: 1900, other_charges_total: 0, cgst_total: 171, sgst_total: 171, igst_total: 0, round_off: 0, grand_total: 2242,
  status, notes: null, internal_notes: null, terms_snapshot: null, footer_snapshot: null, bank_snapshot: null, tax_review_note: null, tax_review_by: null, tax_review_at: null,
  e_invoice_status: 'NOT_CONFIGURED', submitted_by: null, submitted_at: null, issued_by: number ? MANAGER_ID : null, issued_at: number ? NOW : null, cancelled_by: null,
  cancelled_at: null, cancellation_reason: null, created_by: MANAGER_ID, created_at: NOW, updated_by: MANAGER_ID, updated_at: NOW,
  credited: 0, debited: 0, paid: 0, balance_due: null, payment_status: null, display_status: status, days_overdue: null, line_count: 1,
  source: 'DISPATCH', sales_order_id: null, is_proforma: false, proforma_number: null, pricing_mode: 'EXCLUSIVE', invoice_discount_percent: null, invoice_discount_amount: 0,
  invoice_discount_total: 0, transport_details: null, vehicle_number: null, eway_bill_number: null, customer_pan: null, ...extra,
})
const invLine = (id, invoiceId) => ({
  id, company_id: COMPANY_ID, invoice_id: invoiceId, line_no: 1, line_type: 'PRODUCT', product_id: 'p1', sales_order_id: 'so1', sales_order_line_id: 'sol1', fulfilment_line_id: 'fl3',
  sku: 'MOCK-WC-1', description: 'Mock Closet 1', hsn_sac: '6910', unit: 'PCS', quantity: 2, unit_price: 950, discount_percent: 0, discount_amount: 0, gross_amount: 1900,
  taxable_value: 1900, gst_rate: 18, cgst_rate: 9, sgst_rate: 9, igst_rate: 0, cgst_amount: 171, sgst_amount: 171, igst_amount: 0, line_total: 2242, created_at: NOW, updated_at: NOW,
  charge_kind: null, invoice_discount_share: 0,
})
Object.assign(tables, {
  invoiceable_dispatch_list: [{
    fulfilment_line_id: 'fl3', company_id: COMPANY_ID, fulfilment_id: 'f3', fulfilment_number: 'FUL-000003', actual_dispatch_at: NOW, fulfilment_status: 'DISPATCHED',
    sales_order_id: 'so1', sales_order_number: 'SO-000001', customer_id: 'cu1', customer_name_snapshot: 'Acme Ltd', customer_po_number: 'ACME-77', order_currency: 'INR',
    sales_order_line_id: 'sol1', order_line_no: 1, quantity_ordered: 5, order_line_dispatched: 2, unit_price_snapshot: 950, product_id: 'p1', sku: 'MOCK-WC-1',
    product_name: 'Mock Closet 1', hsn_code: '6910', gst_rate: 18, selling_price: 950, unit: 'PCS', quantity_dispatched: 2, quantity_delivered: 0, quantity_returned: 0,
    quantity_invoiced: 0, quantity_invoiceable: 2,
  }],
  sales_invoice_list: [
    invRow('inv1', null, 'DRAFT'),
    invRow('inv2', 'INV/26-27/0001', 'ISSUED', { paid: 1121, balance_due: 1121, payment_status: 'PARTIALLY_PAID', display_status: 'PARTIALLY_PAID' }),
  ],
  sales_invoice_lines: [invLine('il1', 'inv1'), invLine('il2', 'inv2')],
  billing_events: [{ id: 'be1', company_id: COMPANY_ID, entity_type: 'INVOICE', entity_id: 'inv2', invoice_id: 'inv2', event_type: 'ISSUED', from_status: 'DRAFT', to_status: 'ISSUED',
    note: null, details: { invoice_number: 'INV/26-27/0001' }, actor_user_id: MANAGER_ID, created_at: NOW }],
  customer_payment_list: [{
    id: 'pay1', company_id: COMPANY_ID, receipt_number: 'RCT/26-27/0001', customer_id: 'cu1', receipt_date: TODAY, amount_received: 1221, currency: 'INR', payment_method: 'BANK_TRANSFER',
    transaction_reference: 'UTR123', bank_reference: null, notes: null, status: 'RECORDED', verification_status: 'UNVERIFIED', reversal_reason: null, reversed_by: null, reversed_at: null,
    recorded_by: MANAGER_ID, created_at: NOW, customer_code: 'ACME', customer_name: 'Acme Ltd', allocated_amount: 1121, unallocated_amount: 100, allocation_count: 1,
  }],
  invoice_payment_allocation_list: [{
    id: 'al1', company_id: COMPANY_ID, invoice_id: 'inv2', payment_id: 'pay1', allocated_amount: 1121, allocation_date: TODAY, status: 'ACTIVE', reversal_reason: null, reversed_by: null,
    reversed_at: null, created_by: MANAGER_ID, created_at: NOW, invoice_number: 'INV/26-27/0001', invoice_date: TODAY, customer_id: 'cu1', receipt_number: 'RCT/26-27/0001',
    receipt_date: TODAY, payment_method: 'BANK_TRANSFER',
  }],
  adjustment_note_list: [],
  invoice_adjustment_note_lines: [],
})
// --- V2 Stage 7 mock data -----------------------------------------------------
const uq = (unit, quantity) => ({ unit, quantity })
const MGMT_OVERVIEW = (from, to) => ({
  from, to, today: TODAY, currency: 'INR', generated_at: NOW,
  kpis: { sales_invoiced: 14160, sales_order_value: 31860, purchase_received: 4460, purchase_ordered: 4460, production: [uq('PCS', 20)], inventory_value: 2800,
    finished_goods_value: 800, raw_material_value: 1000, uncosted_lots: 0, invoices: 1, receipts: 14160, receipt_count: 2, customer_outstanding: 0, receivables: 0,
    customer_advances: 0, supplier_outstanding: 4460, payables: 4460 },
  inventory: { available: true, by_type: [{ product_type: 'FINISHED_GOOD', unit: 'PCS', on_hand: 8, reserved: 8, available: 0, value: 800, uncosted_lots: 0 },
      { product_type: 'RAW_MATERIAL', unit: 'KG', on_hand: 50, reserved: 17.5, available: 32.5, value: 1000, uncosted_lots: 0 }],
    finished_goods: [uq('PCS', 8)], raw_materials: [uq('KG', 50)], components: [], outsourced_components: [uq('PCS', 20)], physical: [uq('KG', 50), uq('PCS', 28)],
    reserved: [uq('KG', 17.5), uq('PCS', 15)], available_stock: [uq('KG', 32.5), uq('PCS', 13)], rejected: [], incoming: [uq('KG', 10)], low_stock_items: 1, out_of_stock_items: 0,
    production_shortages: 1, total_value: 2800, uncosted_lots: 0, lots: 3,
    by_warehouse: [{ warehouse_code: 'MAIN', warehouse_name: 'Mock main store', unit: 'PCS', on_hand: 28, reserved: 15, available: 13 }],
    low_stock: [{ product_id: 'p3', sku: 'MOCK-CLAY', product_name: 'Mock ceramic body', unit: 'KG', available: 32.5, reorder_level: 40, status: 'LOW_STOCK' }],
    movement: [{ day: TODAY, unit: 'PCS', in: 60, out: 32 }, { day: TODAY, unit: 'KG', in: 100, out: 50 }] },
  purchase: { available: true, total: 2, open: 1, overdue: 1, period_value: 4460, period_orders: 1, outstanding_receipt_value: 210, created: 2, partially_received: 0, completed: 1,
    received_value: 4460, receipts: 1, by_supplier: [{ supplier: 'Shree Clay Works Pvt Ltd', value: 4460, orders: 1 }],
    monthly: [{ month: `${TODAY.slice(0, 7)}-01`, ordered: 4460, received: 4460 }] },
  production: { available: true, total_orders: 1, orders: 1, orders_completed: 1, open_orders: 0, planned: [uq('PCS', 20)], actual: [uq('PCS', 20)], finished_goods: [uq('PCS', 20)],
    raw_materials: [uq('KG', 50)], components: [uq('PCS', 20)], rejected: [], wastage: [], pending: [], shortages: [], daily: [{ day: TODAY, unit: 'PCS', good: 20, rejected: 0 }],
    monthly: [{ month: `${TODAY.slice(0, 7)}-01`, unit: 'PCS', good: 20 }],
    by_product: [{ product_id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', good: 20, rejected: 0, scrap: 0, planned: 20, yield_percent: 100, plan_percent: 100 }] },
  sales: { available: true, total_orders: 2, total_value: 31860, pending: 1, partially_fulfilled: 0, fully_fulfilled: 1, cancelled: 0, awaiting_dispatch: 0,
    finished_goods_reserved: [uq('PCS', 8)], orders_requiring_production: 1, orders_with_shortages: 0, dispatches: 1, dispatched: [uq('PCS', 12)],
    daily: [{ day: TODAY, value: 31860, orders: 2 }], monthly: [{ month: `${TODAY.slice(0, 7)}-01`, value: 31860, orders: 2 }],
    by_product: [{ sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', ordered: 27, value: 31860 }], by_customer: [{ customer: 'Acme Ltd', value: 31860, orders: 2 }] },
  invoicing: { available: true, total_invoices: 1, total_value: 14160, taxable_value: 12000, gst_collected: 2160, amount_received: 14160, outstanding: 0, overdue_amount: 0,
    partially_paid: 0, fully_paid: 1, overdue: [], monthly: [{ month: `${TODAY.slice(0, 7)}-01`, invoiced: 14160, received: 14160, gst: 2160 }],
    gst_summary: [{ gst_rate: 18, taxable: 12000, cgst: 1080, sgst: 1080, igst: 0, tax: 2160 }], customer_outstanding: [] },
  alerts: [
    { code: 'LOW_STOCK', title: 'Low stock', severity: 'WARNING', count: 1, link: '/inventory/alerts', items: [{ label: 'MOCK-CLAY — Mock ceramic body', detail: 'Available 32.5 KG · reorder at 40', link: '/inventory/stock/p3' }] },
    { code: 'PURCHASE_OVERDUE', title: 'Purchase deliveries overdue', severity: 'WARNING', count: 1, link: '/purchase-orders', items: [{ label: 'PO-000001 — Shree Clay Works Pvt Ltd', detail: `Expected ${TODAY}`, link: '/purchase-orders/po1' }] },
    { code: 'SUPPLIER_PAYMENT_PENDING', title: 'Supplier payments pending', severity: 'INFO', count: 1, link: '/ledger', items: [{ label: 'Shree Clay Works Pvt Ltd', detail: 'Payable 4460', link: '/ledger/pty-sup1' }] },
    { code: 'OUT_OF_STOCK', title: 'Out of stock', severity: 'CRITICAL', count: 0, link: '/inventory/alerts', items: [] },
  ],
})
const MODULE_DASHBOARDS = {
  PRODUCTS: { total: 4, active: 3, finished_goods: 2, raw_materials: 1, components: 1, outsourced: 1, other: 0, without_bom: 1, without_bom_list: [{ id: 'p2', sku: 'MOCK-WC-2', product_name: 'Mock Closet 2' }],
    added_in_period: 2, recent: [{ id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', product_type: 'FINISHED_GOOD', created_at: NOW }], low_stock: [], low_stock_count: 0 },
  LEDGER: { customers: 1, suppliers: 2, both: 0, parties: 3, receivables: 1121, payables: 4460, customer_advances: 0, with_balance: 2,
    outstanding: [{ party_id: 'pty-sup1', party_code: 'PTY-000002', name: 'Shree Clay', receivable: 0, payable: 4460 }],
    top_customers: [{ party_id: 'pty-cu1', name: 'Acme Ltd', invoiced: 2242 }], top_suppliers: [{ party_id: 'pty-sup1', name: 'Shree Clay', received: 4460 }] },
  PURCHASE: { total: 3, open: 1, overdue: 1, period_value: 10620, period_orders: 1, outstanding_receipt_value: 8496, partially_received: 1, fully_received: 0,
    overdue_list: [{ id: 'po1', po_number: 'PO-000001', supplier: 'Shree Clay Works Pvt Ltd', expected: TODAY }], top_suppliers: [{ supplier: 'Shree Clay Works Pvt Ltd', value: 10620, orders: 1 }] },
  GRN: { total: 2, today: 1, month: 2, in_period: 2, value_in_period: 4460, pending_orders: 1, pending_value: 8496, rejected: [{ unit: 'PCS', quantity: 2 }], unlinked: 1, reversed: 0,
    recent_items: [{ receipt_id: 'gr1', receipt_number: 'GRN-000001', receipt_date: TODAY, sku: 'MOCK-CLAY', product_name: 'Mock ceramic body', unit: 'KG', accepted: 100, rejected: 0, direct: false }] },
}
// GST-exclusive dashboard figures (migration 20261209090000): taxable values; part-paid invoice flagged for review.
const MONTH0 = `${TODAY.slice(0, 7)}-01`
const EXCL_GST = (scope) => {
  const purchase = scope === 'MANAGEMENT'
    ? { available: true, period_value: 3780, outstanding_receipt_value: 178, received_value: 3780, top_suppliers: [{ supplier: 'Shree Clay Works Pvt Ltd', value: 3780, orders: 1 }],
        monthly: [{ month: MONTH0, ordered: 3780, received: 3780 }] }
    : { available: true, period_value: 9000, outstanding_receipt_value: 7200, received_value: 3780, top_suppliers: [{ supplier: 'Shree Clay Works Pvt Ltd', value: 9000, orders: 1 }],
        monthly: [{ month: MONTH0, ordered: 9000, received: 3780 }] }
  const sales = { available: true, total_value: 27000, order_value: 27000, daily: [{ day: TODAY, value: 27000, orders: 2 }], orders: { so1: 100000 } }
  const invoicing = { available: true, taxable_value: 12000, gst: 2160, invoices: 1, outstanding_excl_gst: 0, outstanding_review: { count: 1, balance: 1121 },
    overdue_excl_gst: 0, overdue_review: { count: 0, balance: 0 }, monthly: [{ month: MONTH0, taxable: 12000, gst: 2160, received: 14160 }],
    by_invoice: { inv2: { taxable: 1900, outstanding_excl_gst: null, status: 'REVIEW' }, inv1: { taxable: 1900, outstanding_excl_gst: null, status: null } } }
  const base = { scope, basis: 'EXCL_GST', generated_at: NOW }
  if (scope === 'MANAGEMENT') return { ...base, purchase, sales, invoicing, sales_invoiced: 12000, invoices: 1,
    receivables: { outstanding_excl_gst: 0, outstanding_incl_gst: 1121, review_count: 1, review_balance: 1121 },
    payables: { outstanding_excl_gst: 3780, outstanding_incl_gst: 4460, review_count: 0, review_balance: 0 }, customer_outstanding: [] }
  if (scope === 'PURCHASE' || scope === 'GRN') return { ...base, purchase }
  if (scope === 'SALES') return { ...base, sales }
  if (scope === 'BILLING') return { ...base, invoicing }
  return { ...base, receivables_excl_gst: 0, receivables_review: { count: 1, balance: 1121 }, payables_excl_gst: 3780, payables_review: { count: 0, balance: 0 },
    by_party: { 'pty-sup1': { receivable_excl_gst: 0, receivable_status: 'SETTLED', payable_excl_gst: 3780, payable_status: 'EXACT' } },
    top_customers: [{ party_id: 'pty-cu1', invoiced: 1900 }], top_suppliers: [{ party_id: 'pty-sup1', received: 3780 }] }
}
// Support Centre (migration 20261210090000): no channel is connected; WhatsApp has an account awaiting its server-side check.
// Acefone telephony (20261211090000). Statuses change only when the mock "provider" reports them.
const PHONE_CALLS = [
  { id: 'call1', direction: 'INBOUND', status: 'MISSED', customer_id: 'scu1', customer_name: 'Ravi Kumar', customer_number: '+919876543210', caller_number: '+919876543210',
    destination_number: '18001234567', agent_name: null, ticket_id: null, ticket_number: null, started_at: '2026-11-12T09:00:00Z', ended_at: '2026-11-12T09:00:25Z',
    ring_seconds: 25, talk_seconds: 0, disposition: 'Missed', has_recording: false, created_at: '2026-11-12T09:00:00Z' },
  { id: 'call2', direction: 'OUTBOUND', status: 'COMPLETED', customer_id: 'scu1', customer_name: 'Ravi Kumar', customer_number: '+919876543210', caller_number: '0501234567',
    destination_number: '+919876543210', agent_name: 'Smoke Agent', ticket_id: 'st1', ticket_number: 'TKT-000001', started_at: '2026-11-12T10:00:00Z', ended_at: '2026-11-12T10:04:10Z',
    ring_seconds: 8, talk_seconds: 242, disposition: 'Answered', has_recording: true, created_at: '2026-11-12T10:00:00Z' },
]
let PHONE_LIVE = []
const PHONE_CONFIG = {
  config: { channel_account_id: 'sca-phone', provider: 'ACEFONE', toll_free_number: '1800 123 4567', api_base_url: 'https://api.acefone.in', click_to_call_mode: 'AGENT', default_caller_id: null,
    api_token_secret: 'ACEFONE_API_TOKEN', support_api_key_secret: 'ACEFONE_C2C_SUPPORT_API_KEY', webhook_secret_name: 'ACEFONE_WEBHOOK_SECRET', webhook_allowed_ips: [],
    recording_retrieval: false, recording_retention_days: 90, is_enabled: true, disconnected_at: null, last_event_at: '2026-11-12T10:04:10Z', last_sync_at: null,
    last_sync_status: null, last_test_at: null, last_test_result: null },
  account: { id: 'sca-phone', status: 'SETUP_REQUIRED', status_detail: 'Waiting for the first verified event.', last_checked_at: null },
  lines: [{ id: 'pl1', agent_id: 'sag1', agent_name: 'Smoke Agent', presence: 'AVAILABLE', agent_active: true, user_id: 'mgr', agent_number: '0501234567', label: 'Desk', is_active: true,
    extension_id: '7001', display_caller_id: '08069411111', softphone_setup: 'INSTRUCTIONS_SENT', provider_agent_status: 'ENABLED', provider_checked_at: NOW }],
  last_success_event_at: '2026-11-12T10:04:10Z',
  events: [{ id: 'pev1', event_type: 'WEBHOOK', status: null, message: null, processing_result: 'ERROR', processing_error: 'simulated', replay_count: 0, created_at: '2026-11-12T10:04:10Z', event: 'hangup' }],
}
const PHONE_DETAIL = (id) => {
  const c = PHONE_CALLS.find((x) => x.id === id)
  if (!c) return null
  const out = c.direction === 'OUTBOUND'
  return { call: { ...c, idem: undefined, conversation_id: 'sc1', agent_number: '0501234567', customer_number_e164: c.customer_number, caller_id_used: null, click_to_call_mode: out ? 'AGENT' : null,
      provider_ref_id: out ? 'REF-1' : null, provider_call_id: 'AC-1', provider_uuid: null, request_state: out ? 'ACCEPTED' : null, request_message: null,
      hangup_cause: null, answered_at: c.talk_seconds ? c.started_at : null, duration_seconds: (c.ring_seconds ?? 0) + (c.talk_seconds ?? 0) },
    customer: { id: 'scu1', customer_code: 'SC-000001', display_name: 'Ravi Kumar' }, ticket: c.ticket_id ? { id: 'st1', ticket_number: 'TKT-000001', subject: 'Cracked basin', status: 'OPEN' } : null,
    agent: c.agent_name ? { id: 'sag1', display_name: c.agent_name } : null, initiated_by: out ? 'Smoke Tester' : null,
    recording: c.has_recording ? { state: 'AT_PROVIDER' } : { state: 'NONE' },
    events: [{ event_name: out ? 'click_to_call' : 'received', from: null, to: out ? 'INITIATED' : 'RINGING', occurred_at: c.started_at, at: c.created_at }] }
}
// Google Workspace Gmail (20261212090000). "Sent" only when the mock Gmail accepted the message.
const GMAIL = { connected: false, sendOutcome: 'PENDING', sendCalls: [], startCalls: 0, originalCalls: [], syncCalls: [] }
// Resumable sync progress (20261224090000); null = the function does not exist yet (before the migration).
const SYNC = { status: null, schedule: null }
// Support live updates (20261225090000): served only by its own step (others see the pre-migration fallback).
const LIVE = { on: false, summary: null, handled: [] }
// Ticket field builder + Product Master links (20261226090000): served only by its own step.
const TF_STANDARD = [['subject', 'Subject', 'TEXT', true, true, false], ['customer', 'Customer', 'LOOKUP', true, false, false], ['products', 'Products (Product Master)', 'PRODUCTS', false, false, true],
  ['customer_phone', 'Phone', 'PHONE', false, false, false], ['customer_email', 'Email', 'EMAIL', false, false, false], ['priority', 'Priority', 'PICKLIST', false, false, false],
  ['assigned_agent', 'Assigned agent', 'USER', false, false, true], ['category', 'Category', 'TEXT', false, false, true], ['subcategory', 'Subcategory', 'TEXT', false, false, true],
  ['department', 'Department', 'TEXT', false, false, true], ['description', 'Description', 'TEXTAREA', false, false, true]]
  .map(([standard_key, label, field_type, locked, required, required_editable]) => ({ standard_key, label, field_type, locked, required, required_editable }))
const tfDef = (id, field_key, field_label, field_type, field_config = {}, over = {}) => ({ id, field_key, field_label, field_type, field_config, is_required: false, is_active: true, default_value: null,
  help_text: null, placeholder: null, visibility: 'ALL_AGENTS', created_at: NOW, updated_at: NOW, value_count: 0, ...over })
const TF = { on: false, stamp: 's0', defs: [], layout: null, values: {}, links: [], saves: [], creates: [], fieldSaves: [], productSaves: [] }
const TF_CATALOGUE = [{ id: 'pm1', sku: 'WB-500', product_name: 'Wall Hung Basin White', model_number: 'WHB-500', barcode: 'BC778899', ean: '4006381333931', brand: null, base_unit: 'PCS', archived: false },
  { id: 'pm2', sku: 'TAP-22', product_name: 'Pillar Tap Chrome', model_number: 'PTC-22', barcode: null, ean: null, brand: null, base_unit: 'PCS', archived: false }]
const tfLayout = () => TF.layout ?? TF_STANDARD.map((x) => ({ standard_key: x.standard_key, field_definition_id: null, is_required_override: null, is_visible: true }))
const tfForm = () => ({ fields: tfLayout().filter((l) => l.is_visible).map((l) => {
    if (l.standard_key) { const x = TF_STANDARD.find((y) => y.standard_key === l.standard_key); return { kind: 'STANDARD', ...x, required: x.required_editable ? Boolean(l.is_required_override) : x.required } }
    const d = TF.defs.find((y) => y.id === l.field_definition_id)
    return d && d.is_active ? { ...d, kind: 'CUSTOM', required: Boolean(l.is_required_override ?? d.is_required) } : null
  }).filter(Boolean), formula_inputs: [], products: { view: true, manage: true, archived: false } })
const GMAIL_CONFIG = () => ({
  config: { channel_account_id: 'sca-mail', provider: 'GOOGLE_WORKSPACE', mailbox_address: 'support@alton.example', display_name: 'Alton Support', signature: 'Alton Support Team',
    pubsub_topic: 'projects/alton-erp-123/topics/gmail-support', push_enabled: true, mailbox_modify_enabled: false, initial_sync_days: 7, max_attachment_mb: 10,
    connected_address: GMAIL.connected ? 'support@alton.example' : null, granted_scopes: GMAIL.connected ? ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'] : [],
    last_history_id: '100', watch_expiration: GMAIL.connected ? '2026-11-20T10:00:00Z' : null, watch_renewed_at: null, watch_status: null, last_push_at: null,
    last_sync_at: GMAIL.connected ? NOW : null, last_sync_status: GMAIL.connected ? 'Mailbox history synchronised: 1 new.' : null, last_full_sync_at: null,
    is_enabled: GMAIL.connected, connected_at: GMAIL.connected ? NOW : null, disconnected_at: null },
  account: { id: 'sca-mail', status: GMAIL.connected ? 'CONNECTED' : 'SETUP_REQUIRED', status_detail: GMAIL.connected ? 'Connected as support@alton.example.' : 'Not connected yet: use Connect Google Workspace.', last_checked_at: NOW, connected_at: null },
  has_credentials: GMAIL.connected,
  requested_scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
  counts: { received: 1, sent: 0, pending: 0, failed: 0 },
  events: [{ id: '55555555-5555-4555-8555-555555555555', event_type: 'WEBHOOK', status: null, message: 'Gmail push notification', processing_result: 'ERROR', processing_error: 'Gmail API unavailable',
    replay_count: 0, created_at: NOW, history_id: '120' }],
})
const GMAIL_THREAD = [
  { id: 'em1', message_id: 'm-em1', direction: 'INBOUND', from_address: 'ravi@customer.example', from_name: 'Ravi Kumar', to: [{ email: 'support@alton.example', name: 'Support' }],
    cc: [{ email: 'boss@customer.example', name: null }], bcc: [], reply_to: null, subject: 'Cracked basin', body_text: 'The basin arrived cracked. Photo attached.',
    has_html: true, html_truncated: false, at: NOW, send_state: null, send_error: null, gmail_message_id: 'aaaa000001', gmail_thread_id: 'thr000001',
    rfc_message_id: '<aaaa000001@customer.example>', in_reply_to: null, unread: true, author: null,
    attachments: [{ id: 'att-em1', file_name: 'photo.jpg', content_type: 'image/jpeg', size_bytes: 20480, inline: false, storage_path: `${COMPANY_ID}/email/em1/1-photo.jpg`, restricted: false }],
    skipped_attachments: [{ filename: 'setup.exe', state: 'BLOCKED', reason: '.exe files are not stored (executable or script).' }] },
]
// Email workspace (20261222090000): threads per folder from the conversations, with the mailbox state set by actions.
// Per-message tools (20261223090000): attachment chips per conversation, per-email stars and reports.
const MAILBOX = { web: false, queries: [], actions: [], state: {}, files: {}, msg: {}, msgActions: [] }
const MAILBOX_PAGE = (p = {}) => {
  const base = [
    { id: 'sc-mail', subject: 'Cracked basin', snippet: 'The basin arrived cracked. Photo attached.', from_name: 'Ravi Kumar', from_address: 'ravi@customer.example', unread_count: 1, has_attachment: true,
      last_direction: 'INBOUND', last_send_state: null, message_count: 1, to: [{ email: 'support@alton.example', name: 'Support' }], senders: ['Ravi Kumar'] },
    { id: 'sc-mail2', subject: 'Invoice copy', snippet: 'Please send the GST invoice for March.', from_name: 'Meera Shah', from_address: 'meera@shop.example', unread_count: 0, has_attachment: false,
      last_direction: 'OUTBOUND', last_send_state: 'SENT', message_count: 2, to: [{ email: 'meera@shop.example', name: 'Meera Shah' }], senders: ['Meera Shah'] },
    ...(MAILBOX.extra ?? []),
  ].map((r) => {
    const st = MAILBOX.state[r.id] ?? { starred: false, important: false, folder: 'INBOX' }
    return { ...r, last_at: NOW, starred: st.starred, important: st.important, snoozed_until: null, folder: st.folder,
      labels: r.id === 'sc-mail' ? [{ id: 'stag1', name: 'Damage', color: 'danger' }] : [], customer_name: 'Ravi Kumar', ticket_id: null, ticket_number: null, assigned_agent: null, status: 'OPEN' }
  })
  const folder = p.folder ?? 'INBOX'
  const rows = base.filter((r) => folder === 'STARRED' ? r.starred : folder === 'LABEL' ? r.labels.some((l) => l.id === p.label) && r.folder !== 'TRASH'
    : folder === 'ALL' ? !['SPAM', 'TRASH'].includes(r.folder) : folder === 'SENT' ? r.last_direction === 'OUTBOUND' : r.folder === folder)
    .filter((r) => !p.q || JSON.stringify(r).toLowerCase().includes(String(p.q).toLowerCase()))
    .filter((r) => !p.from || `${r.from_name} ${r.from_address}`.toLowerCase().includes(String(p.from).toLowerCase()))
    .filter((r) => p.has_attachment === undefined || r.has_attachment === p.has_attachment)
  return { total: rows.length, rows, counts: { INBOX: base.filter((r) => r.folder === 'INBOX' && r.unread_count > 0).length, SPAM: 0, SNOOZED: 0, TRASH: 0 },
    labels: [{ id: 'stag1', name: 'Damage', color: 'danger', unread: 1 }] }
}
// Meta WhatsApp Cloud API (20261213090000). Pending until the (mock) Meta status webhook says otherwise.
const WA = { state: 'MIGRATION_REQUIRED', enabled: false, windowOpen: true, sendCalls: [], templateCalls: [], checklist: [], preflight: null, web: false, prefs: {}, prefCalls: [] }
const WA_ITEMS = [['number_path_confirmed', true], ['cloud_api_eligibility', true], ['migration_completed', true], ['coexistence_approved', false], ['previous_routing_retired', true],
  ['system_user_token', true], ['webhook_subscribed', true], ['templates_reviewed', false]]
const WA_CONFIG = () => ({
  config: { channel_account_id: 'sca-wa', business_portfolio_id: '1234567890', waba_id: '102030405060', phone_number_id: '109876543210', display_phone_number: '+9118001234567',
    app_id: '555666777888', graph_api_version: 'v27.0', number_path: 'BSP', setup_state: WA.state, integration_enabled: WA.enabled, enabled_at: null,
    webhook_verified_at: null, webhook_signed_event_at: null, last_webhook_at: null, last_inbound_at: null, last_outbound_success_at: null, last_test_at: NOW, last_test_ok: true,
    last_test_result: 'Connected: Alton +91 1800 123 4567 on the Cloud API.', phone_info: {}, templates_synced_at: NOW, last_error: null, last_error_at: null },
  account: { id: 'sca-wa', status: WA.enabled ? 'CONNECTED' : 'SETUP_REQUIRED', status_detail: 'The number must be migrated to the Cloud API through Meta\'s supported path first.', last_checked_at: NOW },
  checklist_items: WA_ITEMS.map(([key, required]) => ({ key, label: `Checklist item ${key}`, required, done: WA.checklist.includes(key), note: null, by: WA.checklist.includes(key) ? 'Smoke Tester' : null,
    at: WA.checklist.includes(key) ? NOW : null })),
  templates: [{ id: 'wt1', name: 'order_update', language: 'en', category: 'UTILITY', status: 'APPROVED' }, { id: 'wt2', name: 'promo_offer', language: 'en', category: 'MARKETING', status: 'PENDING' }],
  counts: { received: 2, sent: 1, pending: 0, failed: 1, media_pending: 1 },
  events: [{ id: 'we1', field: 'messages', result: 'HELD', error: 'Integration not switched on.', counts: {}, replay_count: 0, received_at: NOW, processed_at: NOW, purged: false }],
  ...(WA.preflight ? { preflight: WA.preflight() } : {}),
})
const WA_TEMPLATES = [{ id: 'wt1', name: 'order_update', language: 'en', category: 'UTILITY', status: 'APPROVED', parameter_format: 'POSITIONAL',
  components: [{ type: 'BODY', text: 'Hi {{1}}, your order {{2}} is on its way.' }] }]
const WA_THREAD = () => ({
  contact: { wa_id: '919876543210', user_id: null, profile_name: 'Ravi Kumar', last_inbound_at: NOW },
  window_open: WA.windowOpen, window_closes_at: WA.windowOpen ? new Date(Date.now() + 5 * 3600000).toISOString() : null, can_send: WA.enabled,
  messages: [
    { id: 'wm1', message_id: 'swm1', direction: 'INBOUND', type: 'text', body: 'The basin arrived cracked', at: NOW, status: 'RECEIVED', status_at: NOW, error_code: null, error_title: null,
      error_detail: null, media_state: 'NONE', media_error: null, media_filename: null, media_mime: null, location: null, context_wa_message_id: null, wa_message_id: 'wamid.IN1',
      template_name: null, author: null, attachment: null },
    { id: 'wm2', message_id: 'swm2', direction: 'INBOUND', type: 'image', body: 'Crack photo', at: NOW, status: 'RECEIVED', status_at: NOW, error_code: null, error_title: null,
      error_detail: null, media_state: 'PENDING', media_error: null, media_filename: null, media_mime: 'image/jpeg', location: null, context_wa_message_id: null, wa_message_id: 'wamid.IMG1',
      template_name: null, author: null, attachment: null },
    { id: 'wm3', message_id: 'swm3', direction: 'OUTBOUND', type: 'text', body: 'We are sending a replacement.', at: NOW, status: 'READ', status_at: NOW, error_code: null, error_title: null,
      error_detail: null, media_state: 'NONE', media_error: null, media_filename: null, media_mime: null, location: null, context_wa_message_id: 'wamid.IN1', wa_message_id: 'wamid.OUT1',
      template_name: null, author: 'Smoke Tester', attachment: null },
    { id: 'wm4', message_id: 'swm4', direction: 'OUTBOUND', type: 'text', body: 'Are you there?', at: NOW, status: 'FAILED', status_at: NOW, error_code: 131026, error_title: 'Message undeliverable',
      error_detail: 'Receiver is incapable of receiving this message', media_state: 'NONE', media_error: null, media_filename: null, media_mime: null, location: null,
      context_wa_message_id: null, wa_message_id: 'wamid.OUT2', template_name: null, author: 'Smoke Tester', attachment: null },
    { id: 'wm5', message_id: 'swm5', direction: 'INBOUND', type: 'location', body: '[Location] Site, Mumbai', at: NOW, status: 'RECEIVED', status_at: NOW, error_code: null, error_title: null,
      error_detail: null, media_state: 'NONE', media_error: null, media_filename: null, media_mime: null, location: { latitude: 19.07, longitude: 72.87, name: 'Site', address: 'Mumbai' },
      context_wa_message_id: null, wa_message_id: 'wamid.LOC1', template_name: null, author: null, attachment: null }].concat(WA.extra ?? []),
})
// WhatsApp Web screen (20261221090000)
const WA_WEB_INBOX = (body) => {
  const last = { 'sc-wa': { direction: 'OUTBOUND', status: 'FAILED', type: 'text' }, sc1: { direction: 'OUTBOUND', status: 'READ', type: 'text' } }
  let rows = SUPPORT_INBOX.filter((r) => r.channel === 'WHATSAPP').map((r) => ({ ...r, pinned: false, muted: false, favorite: false, ...(WA.prefs[r.id] ?? {}),
    profile_name: 'Ravi Kumar', wa_id: '919876543210', window_open: WA.windowOpen, last_message: last[r.id] ?? null }))
  const counts = { ALL: rows.length, UNREAD: rows.filter((r) => r.unread_count > 0).length, FAVORITES: rows.filter((r) => r.favorite).length, MINE: rows.filter((r) => r.assigned_agent_id === 'sag1').length }
  rows = rows.filter((r) => body.p_view === 'UNREAD' ? r.unread_count > 0 : body.p_view === 'FAVORITES' ? r.favorite : body.p_view === 'MINE' ? r.assigned_agent_id === 'sag1' : true)
    .filter((r) => !body.p_search || JSON.stringify(r).toLowerCase().includes(String(body.p_search).toLowerCase()))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned))
  return { total: rows.length, me: 'sag1', rows, counts }
}
const WA_MESSAGE_INFO = (id) => {
  const m = WA_THREAD().messages.find((x) => x.id === id)
  if (!m) return null
  const receipts = m.status === 'READ' ? [{ status: 'SENT', at: NOW }, { status: 'DELIVERED', at: NOW }, { status: 'READ', at: NOW }]
    : m.status === 'FAILED' ? [{ status: 'FAILED', at: NOW, error_code: 131026, error_title: 'Message undeliverable', error_detail: 'Receiver is incapable of receiving this message' }] : []
  return { id: m.id, direction: m.direction, status: m.status, status_at: m.status_at, type: m.type, at: m.at, created_at: m.at, accepted_by_meta: Boolean(m.wa_message_id),
    template_name: null, error_code: m.error_code, error_title: m.error_title, error_detail: m.error_detail,
    receipts: receipts.map((r) => ({ error_code: null, error_title: null, error_detail: null, ...r })) }
}
// Unified support (20261214090000)
const UNI = { rulesSaves: [], calendarSaves: [], healthTests: 0 }
const UNI_SETTINGS = () => ({
  rules: { ticket_mode: 'AGENT_REQUEST_ONLY', new_conversation_priority: 'NORMAL', missed_call_enabled: false, missed_call_priority: 'HIGH', email_keywords_enabled: false,
    email_keywords: [], email_match_body: false, whatsapp_keywords_enabled: false, whatsapp_keywords: [], keyword_priority: 'NORMAL', reopen_on_reply_enabled: true,
    escalate_on_breach_enabled: false, escalate_priorities: ['URGENT'], sla_warning_percent: 80 },
  calendar: { enabled: false, timezone: 'Asia/Kolkata', working_days: [1, 2, 3, 4, 5, 6], start_time: '09:30:00', end_time: '18:30:00', pause_when_waiting_customer: true },
  holidays: [{ id: 'h1', date: '2026-11-16', name: 'Test holiday' }],
  levels: [{ level: 1, after_minutes: 0, priorities: [], notify_assignee: true, notify_managers: true, reassign_agent_id: null, set_department: 'Escalations', raise_priority: false, is_active: true }],
  assignment: [{ id: 'ar1', name: 'Urgent to quality', channel: null, priority: 'URGENT', department: 'Quality', agent_id: 'sag1', run_order: 100, is_active: true }],
  can_edit: has('support.manage_settings'),
})
const UNI_HEALTH = () => [
  { provider: 'ACEFONE', channel: 'PHONE', configured: true, status: 'SETUP_REQUIRED', status_detail: 'Not tested yet.', verified_by_test_at: null, last_sync_at: null, last_sync_status: null,
    last_webhook_at: NOW, last_outbound_at: null, failed_events_7d: 1, retry_queue: 1, expired_credentials: false, errors: [{ at: NOW, message: 'Signature rejected' }], test_action: 'acefone-click-to-call' },
  { provider: 'GOOGLE_WORKSPACE', channel: 'EMAIL', configured: true, status: 'REAUTHORIZATION_REQUIRED', status_detail: 'Google no longer accepts the authorisation.', verified_by_test_at: null,
    last_sync_at: NOW, last_sync_status: 'ok', last_webhook_at: NOW, last_outbound_at: NOW, failed_events_7d: 0, retry_queue: 2, expired_credentials: true, errors: [], test_action: 'google-oauth-start' },
  { provider: 'META_WHATSAPP', channel: 'WHATSAPP', configured: true, status: 'CONNECTED', status_detail: 'Connected to the WhatsApp Cloud API.', setup_state: 'CONNECTED', enabled: true,
    verified_by_test_at: NOW, last_sync_at: NOW, last_sync_status: 'ok', last_webhook_at: NOW, last_outbound_at: NOW, failed_events_7d: 0, retry_queue: 0, expired_credentials: false, errors: [], test_action: 'whatsapp-sync-status' },
]
const UNI_REPORTS = (from, to) => ({ from, to, channel_volume: [{ day: TODAY, phone: 2, whatsapp: 3, email: 1 }], channel_totals: { phone: 2, whatsapp: 3, email: 1 },
  calls: { inbound: 2, answered: 1, missed: 1, answer_rate: 50, missed_rate: 50, avg_talk_seconds: 95 },
  response_times: { email: { turns: 1, answered: 1, avg_minutes: 42, median_minutes: 42, within_1h_percent: 100 }, whatsapp: { turns: 3, answered: 2, avg_minutes: 6.5, median_minutes: 5, within_1h_percent: 100 } },
  tickets: { created: 4, closed: 2, closure_rate: 50, resolved_in_period: 2, open_now: 2, reopened: 1, by_channel: { whatsapp: 2, email: 1, phone: 1 } },
  agents: [{ agent: 'Smoke Agent', open_tickets: 1, open_conversations: 2, resolved: 2, replies: 7 }],
  sla: { tickets: 4, first_response_met: 3, first_response_breached: 1, resolution_met: 2, resolution_breached: 1, compliance_percent: 75, escalations: 1 },
  csat: { responses: 1, average: 5, distribution: { 5: 1 } } })
const UNI_TICKET_SLA = { policy: { name: 'Urgent', first_response_minutes: 15, resolution_minutes: 240 }, status: 'OVERDUE', business_hours: true, paused: false, paused_since: null, paused_minutes: 30,
  first_response: { due_at: NOW, done_at: null, breached_at: NOW, breached: true, remaining_minutes: -45 },
  resolution: { due_at: NOW, done_at: null, breached_at: null, breached: false, remaining_minutes: 150 },
  history: [{ kind: 'WARNING', target: 'FIRST_RESPONSE', level: 0, at: NOW, details: {} }, { kind: 'BREACH', target: 'FIRST_RESPONSE', level: 0, at: NOW, details: {} },
    { kind: 'ESCALATION', target: 'FIRST_RESPONSE', level: 1, at: NOW, details: {} }] }
// Acefone softphone / agent telephony (20261215090000)
const SOFT = { notes: [], links: [], agentsReads: 0 }
const SOFTPHONE_STATUS = () => ({ phone_configured: true, lines: [{ id: 'pl1', agent_number: '0601234567', extension_id: '7001', label: 'Desk', display_caller_id: '08069411111',
  softphone_setup: 'INSTRUCTIONS_SENT', is_active: true, provider_agent_status: 'ENABLED', provider_checked_at: NOW, state: 'NOT_VERIFIED' }] })
const CALL_CONTEXT = () => ({ notes: SOFT.notes.map((b, i) => ({ id: `n${i}`, body: b, at: NOW, author: 'Smoke Tester' })),
  previous_calls: [{ id: 'call1', direction: 'INBOUND', status: 'MISSED', at: NOW, talk_seconds: 0, agent_name: null }],
  open_tickets: [{ id: 'st1', ticket_number: 'TKT-000001', subject: 'Cracked basin', status: 'OPEN' }],
  conversations: [{ id: 'sc1', channel: 'PHONE', subject: 'Cracked basin', status: 'OPEN', last_activity_at: NOW }] })
const CALL_ANALYTICS = (from, to, group) => ({ from, to, group,
  totals: { inbound: 5, outbound: 3, answered: 4, missed: 2, failed: 1, unconfirmed_requests: 1, avg_duration_seconds: 125, avg_answer_seconds: 9 },
  series: [{ period: TODAY, inbound: 5, outbound: 3, answered: 4, missed: 2, failed: 1 }],
  agents: [{ agent: 'Smoke Agent', inbound: 3, outbound: 3, answered: 4, missed: 1, avg_duration_seconds: 125 }],
  customers: [{ customer_id: 'scu1', customer: 'Ravi Kumar', calls: 4, answered: 3, missed: 1, last_call_at: NOW }, { customer_id: null, customer: 'Unknown caller', calls: 2, answered: 0, missed: 1, last_call_at: NOW }],
  states: { COMPLETED: 4, MISSED: 2, FAILED: 1, REQUESTED: 1 } })
// Bulk BOM management (20261218090000)
const BULK = { batches: [], saves: [], published: 0 }
const BULK_COMPS = {
  'cmp-old': { product_id: 'cmp-old', sku: 'RM-GLAZE-01', product_name: 'Glaze white (old)', base_unit: 'KG', product_type: 'RAW_MATERIAL', status: 'ACTIVE', barcode: 'GLZ0001', ean: null, model_number: 'GZ-1', supplier_model_number: null, bom_lines: 3 },
  'cmp-new': { product_id: 'cmp-new', sku: 'RM-GLAZE-02', product_name: 'Glaze white (new)', base_unit: 'KG', product_type: 'RAW_MATERIAL', status: 'ACTIVE', barcode: null, ean: null, model_number: null, supplier_model_number: null, bom_lines: 0 },
  'cmp-box': { product_id: 'cmp-box', sku: 'PK-BOX-01', product_name: 'Carton box', base_unit: 'PCS', product_type: 'PACKAGING_MATERIAL', status: 'ACTIVE', barcode: null, ean: null, model_number: null, supplier_model_number: null, bom_lines: 0 },
}
const BULK_BOMS = [1, 2, 3].map((i) => ({ bom_id: `bb${i}`, bom_code: `BOM-00010${i}`, version: 1, status: 'APPROVED', lifecycle: 'ACTIVE', is_current: true, effective_from: TODAY, effective_to: null,
  output_quantity: 1, output_unit: 'PCS', finished_product_id: `fgb${i}`, sku: `FG-BASIN-${i}`, product_name: `Basin ${i}`, product_type: 'FINISHED_GOOD', finished_status: 'ACTIVE', line_no: 1,
  component_product_id: 'cmp-old', component_sku: 'RM-GLAZE-01', component_name: 'Glaze white (old)', quantity: i + 0.5, unit: 'KG', inventory_unit: 'KG', unit_matches: true,
  wastage_percentage: 2, notes: null, source_type: 'PURCHASED', quantity_per_unit: i + 0.5 }))
const bulkDetail = (b) => ({ batch: b, lines: b.lines, events: b.events,
  impact: b.status === 'PUBLISHED' ? null : { production_orders: [{ production_order_id: 'po-x', production_order_number: 'PRD-000001', status: 'APPROVED', sku: 'FG-BASIN-1', product_name: 'Basin 1', bom_code: 'BOM-000101', bom_version: 1, planned_quantity: 10, unit: 'PCS', planned_start_date: TODAY, released: true, effect: 'Keeps v1 and its material plan; not changed.' }],
    production_orders_visible: true, stock_visible: true, purchases_visible: true, effective_from: b.effective_from, note: 'Publishing never changes stock, purchase orders, consumption or existing production orders.',
    components: [{ product_id: 'cmp-old', sku: 'RM-GLAZE-01', product_name: 'Glaze white (old)', unit: 'KG', roles: 'REMOVED', boms_in_batch: 3, current_boms: 3, current_boms_after: 0, on_hand: 40, reserved: 0, available: 40, open_po_quantity: 25, open_po_count: 1, consumed_90_days: 12, open_order_requirement: 5 },
      { product_id: 'cmp-new', sku: 'RM-GLAZE-02', product_name: 'Glaze white (new)', unit: 'KG', roles: 'ADDED', boms_in_batch: 3, current_boms: 0, current_boms_after: 0, on_hand: 0, reserved: 0, available: 0, open_po_quantity: 0, open_po_count: 0, consumed_90_days: 0, open_order_requirement: 0 }] },
  permissions: { can_edit: ['DRAFT', 'REJECTED'].includes(b.status), can_approve: b.status === 'PENDING_APPROVAL', can_publish: b.status === 'APPROVED', self_approval_blocked: false } })
const bulkEvent = (b, action, note = null) => { b.events.push({ action, acted_at: NOW, note, details: {}, actor_name: 'Smoke Tester' }); b.row_version++ }
const SUPPORT_CHANNELS = [{ channel: 'PHONE', status: 'NOT_CONNECTED', accounts: 0 }, { channel: 'WHATSAPP', status: 'SETUP_REQUIRED', accounts: 1 }, { channel: 'EMAIL', status: 'NOT_CONNECTED', accounts: 0 }]
const supportConv = (id, channel, over = {}) => ({ id, channel, subject: null, status: 'OPEN', priority: 'NORMAL', customer_id: null, customer_name: 'Ravi Kumar', phone: '+91 98765 43210',
  email: null, last_message_preview: 'Basin arrived cracked', last_activity_at: NOW, unread_count: 0, assigned_agent_id: null, assigned_agent: null, ticket_id: null, ticket_number: null, tags: [], ...over })
const SUPPORT_INBOX = [
  supportConv('sc1', 'WHATSAPP', { subject: 'Cracked basin', unread_count: 2, assigned_agent_id: 'sag1', assigned_agent: 'Smoke Agent', ticket_id: 'st1', ticket_number: 'ALT-SUP-000001',
    customer_id: 'scu1', tags: [{ id: 'stag1', name: 'Damage', color: 'danger' }] }),
  supportConv('sc2', 'PHONE', { customer_name: '+91 90000 11111', phone: '+91 90000 11111', last_message_preview: 'Missed call', status: 'PENDING' }),
]
const supportTicket = (id, n, over = {}) => ({ id, ticket_number: `ALT-SUP-${String(n).padStart(6, '0')}`, subject: 'Cracked basin on delivery', customer_id: 'scu1', customer_name: 'Ravi Kumar',
  customer_phone: '+91 98765 43210', customer_email: null, channel: 'WHATSAPP', category: 'Damage', subcategory: null, priority: 'URGENT', status: 'OPEN', department: 'Quality',
  assigned_agent_id: 'sag1', assigned_agent: 'Smoke Agent', created_at: NOW, first_response_at: null, due_at: NOW, resolved_at: null, closed_at: null, sla_status: 'AT_RISK',
  merged_into: null, related_type: null, related_reference: null, csat_rating: null, reopen_count: 0, ...over })
const SUPPORT_TICKETS = [supportTicket('st1', 1), supportTicket('st2', 2, { subject: 'Invoice copy', priority: 'LOW', status: 'RESOLVED', sla_status: 'MET', resolved_at: NOW, channel: 'EMAIL', category: null, csat_rating: 5 })]
const SUPPORT_OVERVIEW = (from, to) => ({ from, to, today: TODAY, generated_at: NOW,
  kpis: { total_tickets: 2, open_tickets: 1, unassigned_tickets: 0, pending_customer: 0, resolved_tickets: 1, overdue_tickets: 0, calls_today: 1, missed_calls: 1,
    whatsapp_conversations: 1, incoming_emails: 0, avg_first_response_minutes: 42, avg_resolution_minutes: 200, csat_average: 5, csat_responses: 1 },
  by_channel: [{ channel: 'WHATSAPP', tickets: 1 }, { channel: 'EMAIL', tickets: 1 }], by_status: [{ status: 'OPEN', tickets: 1 }, { status: 'RESOLVED', tickets: 1 }],
  daily: [{ day: TODAY, created: 2, resolved: 1 }], sla: { met: 1, breached: 0, no_sla: 0 }, resolution_buckets: [{ bucket: '1–4 hours', tickets: 1 }],
  agents: [{ agent_id: 'sag1', name: 'Smoke Agent', presence: 'AVAILABLE', is_active: true, assigned_open: 1, resolved: 1, avg_resolution_minutes: 200, sla_met: 1, sla_breached: 0, open_conversations: 1 }],
  channels: SUPPORT_CHANNELS })
const SUPPORT_CONVERSATION = (id) => {
  const r = SUPPORT_INBOX.find((x) => x.id === id) ?? SUPPORT_INBOX[0]
  return { conversation: { id: r.id, channel: r.channel, subject: r.subject, status: r.status, priority: r.priority, customer_id: r.customer_id, ticket_id: r.ticket_id,
      contact_name: null, contact_phone: r.phone, contact_email: null, assigned_agent_id: r.assigned_agent_id, unread_count: r.unread_count, last_activity_at: NOW, created_at: NOW },
    channel_status: SUPPORT_CHANNELS.find((c) => c.channel === r.channel).status,
    customer: r.customer_id ? { id: 'scu1', customer_code: 'SC-000001', display_name: 'Ravi Kumar', phones: ['+91 98765 43210'], emails: [] } : null,
    candidates: r.customer_id ? [] : [{ id: 'scu1', customer_code: 'SC-000001', display_name: 'Ravi Kumar', matched_on: ['phone'] }, { id: 'scu2', customer_code: 'SC-000002', display_name: 'Ravi Kumar (shop)', matched_on: ['phone'] }],
    ticket: r.ticket_id ? { id: 'st1', ticket_number: 'ALT-SUP-000001', subject: 'Cracked basin on delivery', status: 'OPEN', priority: 'URGENT', sla_status: 'AT_RISK' } : null,
    agent: r.assigned_agent_id ? { id: 'sag1', display_name: 'Smoke Agent' } : null, tags: r.tags,
    timeline: [
      { type: r.channel === 'PHONE' ? 'call' : 'message', id: 'm1', at: NOW, direction: 'INBOUND', source: 'MANUAL', body: r.channel === 'PHONE' ? null : 'The basin arrived cracked.',
        call_status: r.channel === 'PHONE' ? 'MISSED' : null, duration_seconds: null, delivery_status: null, author: 'Smoke Tester' },
      { type: 'note', id: 'n1', at: NOW, body: 'Checked stock for a replacement', author: 'Smoke Tester' },
      { type: 'attachment', id: 'a1', at: NOW, file_name: 'call.mp3', is_recording: true, is_sensitive: true, storage_path: null, restricted: true },
    ] }
}
const SUPPORT_TICKET_DETAIL = (id) => {
  const t = SUPPORT_TICKETS.find((x) => x.id === id) ?? supportTicket(id, 9, { subject: 'New smoke ticket', status: 'NEW' })
  return { ticket: { ...t, description: 'The basin arrived cracked.', first_response_due_at: NOW, csat_comment: null, related_id: null, merged_into: null, merged_from: [],
      merged_into_ticket_id: null, updated_at: NOW },
    customer: { id: 'scu1', customer_code: 'SC-000001', display_name: 'Ravi Kumar' }, agent: { id: 'sag1', display_name: 'Smoke Agent' },
    sla_policy: { name: 'Urgent', first_response_minutes: 15, resolution_minutes: 240 },
    conversations: [{ id: 'sc1', channel: 'WHATSAPP', subject: 'Cracked basin', status: 'OPEN', last_message_preview: 'Basin arrived cracked', last_activity_at: NOW }],
    events: [{ id: 'e1', event_type: 'CREATED', from: null, to: 'NEW', details: {}, at: NOW, author: 'Smoke Tester' }],
    notes: [], attachments: [] }
}
// Inventory by category rows of the mock inventory overview (a step varies the count and the names).
let CATEGORY_ROWS = null
const ERP_DEFAULTS = {
  'general.date_format': 'DD MMM YYYY', 'numbering.po_prefix': 'PO', 'numbering.grn_prefix': 'GRN', 'numbering.production_prefix': 'PRD', 'numbering.sales_order_prefix': 'SO',
  'product.auto_sku': true, 'product.sku_prefixes': { FINISHED_GOOD: 'FG', RAW_MATERIAL: 'RM', COMPONENT: 'CMP', SUBASSEMBLY: 'SUB', OUTSOURCED_COMPONENT: 'OSC', PACKAGING_MATERIAL: 'PKG', CONSUMABLE: 'CON', OTHER: 'ITM' },
  'product.units': ['PCS', 'NOS', 'SET', 'KG', 'LTR'], 'product.default_gst_rate': 18, 'product.hsn_codes': [{ code: '6910', description: 'Ceramic sanitary ware', gst_rate: 18 }],
  'inventory.opening_cost_override': false, 'inventory.adjustment_reasons': ['Damaged', 'Count correction'], 'purchase.default_payment_terms': 'DAYS_30', 'purchase.default_delivery_terms': null,
  'production.default_wastage_percent': 0, 'production.consumption_prefill': 'STANDARD', 'sales.default_payment_terms': null, 'sales.default_delivery_instructions': null,
  'sales.default_warehouse_id': null, 'import.date_order': 'DMY', 'product.import_match_key': 'SKU',
  'product.purchase_cost_auto_update': true, 'product.purchase_cost_increase_alerts': true, 'product.purchase_cost_decrease_alerts': true,
  'product.purchase_cost_alert_percent': 10, 'product.purchase_cost_zero_policy': 'IGNORE', 'product.purchase_cost_override_permission': 'purchase_exception.approve',
}
const pcEvent = (id, over) => ({ id, event_type: 'GRN_RECEIPT', status: 'APPLIED', not_applied_reason: null, previous_cost: null, new_cost: 850,
  difference: null, change_percent: null, change_type: 'INITIAL_COST', significant: false, received_quantity: 10, rejected_quantity: 0, unit: 'PCS', currency: 'INR',
  cost_basis: { method: 'PO_LINE_TAXABLE_VALUE_PER_UNIT' }, supplier_id: 'sup1', supplier_name: 'Shree Clay Works Pvt Ltd', purchase_order_id: 'po3', po_number: 'PO-000003',
  goods_receipt_id: 'gr1', receipt_number: 'GRN-000001', effective_date: '2026-10-20', posted_at: NOW, reason: 'Goods receipt GRN-000001 against PO-000003',
  created_at: '2026-10-20T10:00:00Z', reversed: false, created_by_name: 'Smoke Tester', ...over })
const PC_EVENTS = [
  pcEvent('pce3', { event_type: 'GRN_REVERSAL', status: 'NOT_APPLIED', not_applied_reason: 'A later receipt sets the current cost, so it is unchanged', previous_cost: 920,
    new_cost: 920, change_type: 'NO_CHANGE', receipt_number: 'GRN-000005', goods_receipt_id: 'gr5', received_quantity: -2, effective_date: TODAY, created_at: `${TODAY}T12:00:00Z` }),
  pcEvent('pce2', { previous_cost: 850, new_cost: 920, difference: 70, change_percent: 8.24, change_type: 'INCREASE', supplier_id: 'sup2', supplier_name: 'Morbi Tiles LLP',
    receipt_number: 'GRN-000010', goods_receipt_id: 'gr9', effective_date: TODAY, created_at: `${TODAY}T09:00:00Z` }),
  pcEvent('pce1', {}),
]
/** product_master_list row (migration 20261128090000) for the mock catalogue. */
function masterRow(p) {
  const fallback = p.standard_manufacturing_cost ?? p.standard_cost ?? null
  const bought = p.id === 'p1'
  const cost = bought ? 850 : fallback
  const last = bought ? 920 : null
  return { ...p, master_cost: cost, master_cost_source: bought ? 'PURCHASE' : fallback === null ? null : 'STANDARD',
    master_cost_receipt_number: bought ? 'GRN-000009' : null, master_cost_receipt_date: bought ? '2026-10-20' : null, fallback_cost: fallback,
    last_purchase_cost: last, last_purchase_date: bought ? TODAY : null, master_cost_change: last === null || cost === null ? null : last - cost,
    master_cost_change_percent: last === null || !cost ? null : Math.round((last - cost) / cost * 10000) / 100,
    // Cost Intelligence (migration 20261208090000): p1 has an approved BOM whose cost is stored; its cost is still the earlier rule.
    bom_manufacturing_cost: bought ? 1320.69 : null, bom_cost_bom_code: bought ? 'BOM-000001' : null, bom_cost_version: bought ? 1 : null,
    bom_cost_status: bought ? 'COMPLETE' : null, bom_cost_at: bought ? NOW : null, master_cost_reference: null, cost_updated_at: null,
    default_cost_source: 'BOM', cost_status: 'NO_NEW_COST', cost_status_note: bought ? 'No new cost available: recalculate to apply the BOM cost.' : null }
}
const PC_HISTORY = {
  product: { id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', base_unit: 'PCS', standard_cost: 1200, standard_manufacturing_cost: 1200, mrp: 1500, selling_price: 1300 },
  current: { cost: 920, date: TODAY, previous_cost: 850, difference: 70, change_percent: 8.24, change_type: 'INCREASE', supplier_name: 'Morbi Tiles LLP', source_event_id: 'pce2' },
  average_inventory_cost: 884.5,
  settings: { auto_update: true, increase_alerts: true, decrease_alerts: true, alert_percent: 10, zero_policy: 'IGNORE', override_permission: 'purchase_exception.approve',
    trigger: 'GRN_POSTING', history: true },
  can_override: true,
}
const ERP_SETTINGS = {
  company: { id: COMPANY_ID, legal_name: 'Test Co', display_name: 'Test Co', company_code: 'TEST', legal_address: 'Mock Road, Pune', state: 'Maharashtra', country: 'India',
    gstin: '27AAAAA0000A1Z5', state_code: '27', state_name: 'Maharashtra', pan: null, cin: null, phone: null, email: null, website: null, currency_code: 'INR', timezone: 'Asia/Kolkata',
    logo_data_url: null, fy_start_month: 4, current_financial_year: '2026-27' },
  settings: { ...ERP_DEFAULTS }, defaults: { ...ERP_DEFAULTS }, counters: { PO: 3, GRN: 1, PRD: 1, SO: 2 },
  warehouses: [{ id: 'w1', code: 'MAIN', name: 'Mock main store', is_default: true }],
}

const RECEIVABLE = { invoice_id: 'inv2', invoice_number: 'INV/26-27/0001', invoice_date: TODAY, due_date: TODAY, customer_id: 'cu1', customer_name: 'Acme Ltd', customer_code: 'ACME',
  grand_total: 2242, credited: 0, debited: 0, paid: 1121, balance: 1121, days_overdue: 0, bucket: 'NOT_DUE' }
const BILLING_OVERVIEW = {
  has_records: true, currency: 'INR', invoiced_total: 2242, received_total: 1221, outstanding_total: 1121, overdue_total: 0, customer_credit_total: 0, unallocated_receipts_total: 100,
  invoices_issued: 1, drafts_awaiting: 1, pending_approval: 0, partially_paid: 1, fully_paid: 0, monthly: [{ month: `${TODAY.slice(0, 7)}-01`, invoiced: 2242, collected: 1221 }],
  outstanding_by_customer: [{ customer_id: 'cu1', customer_name: 'Acme Ltd', balance: 1121, overdue: 0 }],
  ageing: [{ bucket: 'NOT_DUE', amount: 1121, invoices: 1 }, { bucket: '1_30', amount: 0, invoices: 0 }, { bucket: '31_60', amount: 0, invoices: 0 }, { bucket: '61_90', amount: 0, invoices: 0 }, { bucket: 'OVER_90', amount: 0, invoices: 0 }],
  top_customers: [{ customer_id: 'cu1', customer_name: 'Acme Ltd', invoiced: 2242, invoices: 1 }],
  recent_invoices: [{ id: 'inv2', invoice_number: 'INV/26-27/0001', invoice_date: TODAY, customer_legal_name: 'Acme Ltd', grand_total: 2242, balance_due: 1121, display_status: 'PARTIALLY_PAID' }],
  recent_receipts: [{ id: 'pay1', receipt_number: 'RCT/26-27/0001', receipt_date: TODAY, customer_name: 'Acme Ltd', amount_received: 1221, unallocated_amount: 100, payment_method: 'BANK_TRANSFER', status: 'RECORDED' }],
  overdue_invoices: [], as_of: NOW, today: TODAY,
}

// --- Administration & Productivity mock data (Phase 10; test process only) ---
const P10_PRODUCT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
Object.assign(tables, {
  notifications: [
    { id: 'n1', notification_type: 'APPROVAL_REQUESTED', title: 'Approval needed: ADJ-000001', message: 'Stock adjustment waiting for your approval (stage 1 of 1).', severity: 'HIGH',
      related_entity_type: 'STOCK_ADJUSTMENT', related_entity_id: 'a1', link: '/admin/approvals?request=ar1', created_at: NOW, read_at: null, dismissed_at: null },
    { id: 'n2', notification_type: 'IMPORT_FAILED_ROWS', title: 'Product import finished with rejected rows', message: '1 of 3 rows rejected.', severity: 'MEDIUM',
      related_entity_type: null, related_entity_id: null, link: '/admin/bulk-operations', created_at: NOW, read_at: NOW, dismissed_at: null },
  ],
  notification_preferences: [],
  approval_workflows: [{ id: 'wf1', name: 'Large adjustments', description: null, document_type: 'STOCK_ADJUSTMENT', min_amount: null, max_amount: null, allow_self_approval: false,
    distinct_stage_approvers: true, require_rejection_reason: true, escalate_after_hours: 24, escalate_to_role: 'ADMIN', is_active: true, version: 2, updated_at: NOW }],
  approval_workflow_stages: [{ id: 'st1', workflow_id: 'wf1', stage_no: 1, name: 'Inventory review', approver_roles: ['INVENTORY_MANAGER'], approver_user_ids: [], required_approvals: 1 }],
  document_list: [{ id: 'd1', company_id: COMPANY_ID, document_type: 'QUALITY_REPORT', title: 'QC report batch G-1', description: null, related_entity_type: 'PRODUCT', related_entity_id: 'p1',
    related_reference: 'MOCK-WC-1', status: 'ACTIVE', current_version: 2, created_by: MANAGER_ID, created_at: NOW, updated_at: NOW, archived_at: null, archive_reason: null,
    current_version_id: 'dv2', original_filename: 'qc-report-v2.pdf', file_size: 20480, mime_type: 'application/pdf', extension: 'pdf', uploaded_at: NOW, uploaded_by: MANAGER_ID, version_count: 2 }],
  document_versions: [
    { id: 'dv2', document_id: 'd1', version: 2, original_filename: 'qc-report-v2.pdf', file_size: 20480, mime_type: 'application/pdf', status: 'AVAILABLE', uploaded_by: MANAGER_ID, uploaded_at: NOW, change_note: 'Corrected lot number', checksum_sha256: null },
    { id: 'dv1', document_id: 'd1', version: 1, original_filename: 'qc-report.pdf', file_size: 19000, mime_type: 'application/pdf', status: 'AVAILABLE', uploaded_by: MANAGER_ID, uploaded_at: NOW, change_note: null, checksum_sha256: null },
  ],
  import_jobs: [{ id: 'ij1', import_type: 'PRODUCTS', source_id: null, source_reference: null, file_name: 'products-oct.xlsx', status: 'COMPLETED_WITH_ERRORS', total_rows: 3, success_rows: 1,
    failed_rows: 1, duplicate_rows: 1, skipped_rows: 0, retry_of_job_id: null, started_by: MANAGER_ID, started_at: NOW, completed_at: NOW, notes: null }],
  import_job_rows: [
    { id: 'jr1', job_id: 'ij1', row_number: 3, outcome: 'FAILED', reference: 'BAD-1', messages: ['GST rate must be one of 0, 5, 12, 18, 28'], row_data: { SKU: 'BAD-1', 'Product name': 'Broken', 'GST rate': '17' } },
    { id: 'jr2', job_id: 'ij1', row_number: 4, outcome: 'DUPLICATE', reference: 'MOCK-WC-1', messages: ['SKU already exists'], row_data: { SKU: 'MOCK-WC-1', 'Product name': 'Mock Closet 1', 'GST rate': '18' } },
  ],
  audit_logs: [
    { id: 'au1', company_id: COMPANY_ID, actor_user_id: MANAGER_ID, action: 'inventory.receipt', resource_type: 'inventory_transaction', resource_id: '0d9f3c1e-1111-4111-8111-000000000001',
      event_timestamp: NOW, metadata: { module: 'inventory', result: 'success', transaction_number: 'TXN-000001' } },
    { id: 'au2', company_id: COMPANY_ID, actor_user_id: VIEWER_ID, action: 'auth.access_denied', resource_type: 'auth', resource_id: null, event_timestamp: NOW, metadata: { path: '/users' } },
  ],
  companies: [{ id: COMPANY_ID, legal_name: 'Test Co', display_name: 'Test Co', timezone: 'Asia/Kolkata', currency_code: 'INR' }],
  company_settings: [{ id: 'cs1', company_id: COMPANY_ID, setting_key: 'documents.max_file_mb', setting_value: 10 }],
})
const APPROVAL_REQUEST = (id, status, extra = {}) => ({
  id, document_type: 'STOCK_ADJUSTMENT', document_id: 'a1', reference: 'ADJ-000001', amount: null, status, workflow: 'Large adjustments', workflow_version: 2, stage: 1, stages: 1,
  stage_name: 'Inventory review', required_approvals: 1, stage_approvals: 0, requested_by: VIEWER_ID, requested_by_name: 'Viewer Tester', requested_at: NOW, comment: 'Breakage in store',
  decided_at: null, cancel_reason: null, consumed_at: null, can_decide: false, mine: false, link: '/inventory/adjustments?adjustment=a1', stale: false, require_rejection_reason: true,
  decisions: [], ...extra,
})
const scanProduct = { kind: 'PRODUCT', id: P10_PRODUCT_ID, label: 'MOCK-WC-1', detail: 'Mock Closet 1', barcode: '8901234567890', unit: 'PCS', status: 'ACTIVE', matched_on: 'BARCODE',
  on_hand: 140, available: 130, track_batches: false, link: `/inventory/stock/${P10_PRODUCT_ID}` }
const barcodeLookup = (code) => {
  const c = String(code ?? '').trim()
  if (c === '8901234567890' || c.toLowerCase() === 'mock-wc-1' || c.endsWith(`P-${P10_PRODUCT_ID}`)) return [{ ...scanProduct, matched_on: c.includes('P-') ? 'QR' : c === '8901234567890' ? 'BARCODE' : 'SKU' }]
  if (c.toUpperCase() === 'MAIN/GENERAL') return [{ kind: 'LOCATION', id: 'l1', label: 'MAIN/GENERAL', detail: 'General area', warehouse_id: 'w1', usage: 'STORAGE', status: 'ACTIVE', matched_on: 'LOCATION_CODE', link: '/inventory/warehouses' }]
  return []
}

// --- Analytics mock data (Phase 9; exists only in this test process) --------
const failNext = new Set()
const has = (p) => currentUser.permissions.includes(p)
const na = (p) => ({ available: false, reason: `Your role does not include the ${p} permission.` })
const analyticsContext = () => ({
  company: { legal_name: 'Test Co', display_name: 'Test Co', currency_code: 'INR' }, timezone: 'Asia/Kolkata', today: TODAY, fy_start_month: 4,
  access: { sales: has('sales_orders.read'), fulfilment: has('fulfilment.read'), billing: has('billing_reports.read'), payments: has('payments.read'), inventory: has('inventory.read'),
    valuation: has('inventory_reports.read'), production: has('manufacturing.read'), outsourcing: has('outsourcing.read'), purchase_orders: has('customer_po.read'),
    shortages: has('customer_po_shortages.read'), data_quality: has('audit_logs.read') },
  export: { sales: has('fulfilment_reports.export'), billing: has('billing_reports.export'), inventory: has('inventory.export'), production: has('production_reports.export'),
    purchase_orders: has('customer_po_reports.export'), data_quality: has('audit_logs.read') },
  warehouses: [{ id: 'w1', code: 'MAIN', name: 'Mock main store' }], categories: [{ id: 'c2', name: 'Water Closets / Toilets' }], generated_at: NOW,
})
const analyticsExecutive = (body) => ({
  from: body.p_from, to: body.p_to, as_of: TODAY, today: TODAY, timezone: 'Asia/Kolkata', currency: 'INR',
  sales: has('sales_orders.read') ? { available: true, has_records: true, orders_created: 2, order_value: 4750, unpriced_order_lines: 1, other_currency_lines: 0, dispatched_value: 1900,
    unpriced_dispatch_lines: 0, quantity_dispatched: [{ unit: 'PCS', quantity: 2 }], dispatches_completed: 1, orders_awaiting_fulfilment: 1, orders_with_shortages: 1, partially_fulfilled: 1 } : na('sales_orders.read'),
  billing: has('billing_reports.read') ? { available: true, has_records: true, invoices_issued: 1, invoiced_total: 2242, invoiced_taxable: 1900, credit_notes_total: 0, debit_notes_total: 0,
    payments_received: 1221, receipts_count: 1, outstanding: 1121, customer_credits: 0, overdue: 0, overdue_invoices: 0, partially_paid: 1, open_invoices: 1,
    unallocated_receipts: 100, unallocated_receipts_count: 1 } : na('billing_reports.read'),
  inventory: has('inventory.read') ? { available: true, has_records: true, active_products: 1, low_stock_products: 0, out_of_stock_products: 0, fully_reserved_products: 0,
    never_stocked_products: 0, shortage_products: 1, shortage_units: [{ unit: 'PCS', quantity: 3 }],
    units: [{ unit: 'PCS', on_hand: 140, reserved: 10, available: 130, in_house: 100, outsourced: 40, unknown: 0, quarantine: 0, rejected: 0, external: 0 }],
    by_warehouse: [{ warehouse_id: 'w1', warehouse_code: 'MAIN', warehouse_name: 'Mock main store', unit: 'PCS', on_hand: 140, available: 130 }] } : na('inventory.read'),
  valuation: has('inventory_reports.read') ? { available: false, method: 'Weighted-average receipt cost of each lot', lots: 2, costed_lots: 1, uncosted: [{ unit: 'PCS', quantity: 40 }],
    complete: false, value: null, costed_value: 45000, reason: 'Valuation unavailable — cost data required for 1 of 2 lots on hand.' } : na('inventory_reports.read'),
  production: has('manufacturing.read') ? { available: true, has_records: true, orders_created: 1, orders_in_progress: 1, orders_completed: 0, orders_due: 1, orders_due_completed: 0,
    completion_rate: 0, planned_vs_actual: [{ unit: 'PCS', planned: 10, good: 4, rejected: 0, scrap: 1 }], output_in_period: [{ unit: 'PCS', good: 4, rejected: 0, scrap: 1 }],
    material_shortages: 1, delayed_orders: 0,
    outsourcing: has('outsourcing.read') ? { available: true, in_progress: 1, awaiting_receipt: [{ unit: 'PCS', quantity: 6 }], overdue: 0, received_in_period: [] } : na('outsourcing.read') } : na('manufacturing.read'),
  generated_at: NOW,
})
const monthStart = `${TODAY.slice(0, 7)}-01`
const ANALYTICS_SALES = (body) => ({
  from: body.p_from, to: body.p_to, bucket: body.p_bucket, currency: 'INR', has_records: true, invoices_available: has('billing_reports.read'),
  totals: { orders: 2, order_value: 4750, unpriced_order_lines: 1, dispatched_value: 1900, unpriced_dispatch_lines: 0, dispatches: 1, invoiced_value: 1900, credit_notes: 0, debit_notes: 0 },
  monthly: [{ month: monthStart, order_value: 4750, orders: 2, dispatched_value: 1900, invoiced_value: 1900, credit_notes: 0, debit_notes: 0 }],
  trend: [{ bucket: TODAY, orders: 2, order_value: 4750 }],
  top_customers_ordered: [{ customer_id: 'cu1', customer_key: 'C:cu1', customer: 'Acme Ltd', value: 4750, orders: 2 }],
  top_customers_dispatched: [{ customer_id: 'cu1', customer_key: 'C:cu1', customer: 'Acme Ltd', value: 1900, dispatches: 1 }],
  top_customers_invoiced: [{ customer_id: 'cu1', customer: 'Acme Ltd', value: 1900 }],
  by_product: [{ product_id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', ordered: 5, order_value: 4750, dispatched: 2, dispatched_value: 1900 }],
  by_category: [{ category_id: 'c2', category: 'Water Closets / Toilets', order_value: 4750, dispatched_value: 1900 }],
  salesperson: { available: false, reason: 'Sales orders do not record a salesperson. The user who created an order is not treated as its salesperson.' },
  fulfilment: { orders: 2, fully_dispatched: 0, partially_dispatched: 1, not_dispatched: 1, order_rate: 0, units: [{ unit: 'PCS', ordered: 6, dispatched: 2, rate: 33.3 }] },
  open_lines: { lines: 1, short_lines: 1, orders_short: 1, by_unit: [{ unit: 'PCS', remaining: 3, reserved: 0, shortage: 3 }],
    rows: [{ sales_order_id: 'so1', sales_order_number: 'SO-000001', customer: 'Acme Ltd', customer_po_number: 'ACME-77', order_status: 'IN_FULFILMENT', sku: 'MOCK-WC-1',
      product_name: 'Mock Closet 1', unit: 'PCS', ordered: 5, dispatched: 2, remaining: 3, reserved: 0, available_now: 0, shortage: 3 }] },
  generated_at: NOW,
})
const ANALYTICS_INVENTORY = (body) => ({
  from: body.p_from, to: body.p_to, bucket: body.p_bucket, today: TODAY, has_records: true,
  current: {
    by_warehouse: [{ warehouse_id: 'w1', warehouse: 'MAIN', warehouse_name: 'Mock main store', unit: 'PCS', on_hand: 140, reserved: 10, available: 130 }],
    by_category: [{ category_id: 'c2', category: 'Water Closets / Toilets', unit: 'PCS', on_hand: 140, available: 130 }],
    by_source: [{ unit: 'PCS', in_house: 100, outsourced: 40, unknown: 0, in_house_available: 90, outsourced_available: 40 }],
    by_usage: [{ unit: 'PCS', usage: 'STORAGE', on_hand: 140 }],
    top_available: [{ product_id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', available: 130, reserved: 10 }],
    below_reorder_count: 0, below_reorder: [], zero_stock_count: 0, zero_stock: [],
    reservation_utilisation: [{ unit: 'PCS', storage_on_hand: 140, reserved: 10, percent: 7.1 }],
    reservations_by_type: [{ reference_type: 'SALES_ORDER_LINE', unit: 'PCS', quantity: 10, reservations: 1 }],
    expiry: { expired: [], expiring_30: [], lots: [] },
  },
  period: {
    balances: [{ unit: 'PCS', opening: 0, closing: 140, net_change: 140 }],
    trend: [{ bucket: TODAY, unit: 'PCS', in: 140, out: 0 }],
    by_type: [{ transaction_type: 'RECEIPT', unit: 'PCS', in: 140, out: 0, transactions: 2 }],
    transfers: { count: 0, between_warehouses: 0, routes: [] },
    adjustments: { posted: 0, pending_approval: 1, by_reason: [] },
    counts: { posted_counts: 0, lines_counted: 0, lines_with_variance: 0, pending_review: 0, by_unit: [], rows: [] },
  },
  valuation: analyticsExecutive(body).valuation, generated_at: NOW,
})
const ANALYTICS_PRODUCTION = (body) => ({
  from: body.p_from, to: body.p_to, today: TODAY, has_records: true, by_status: [{ status: 'IN_PROGRESS', orders: 1 }], orders_due: 1, orders_due_completed: 0, completion_rate: 0,
  planned_vs_actual: [{ unit: 'PCS', planned: 10, good: 4, rejected: 0, scrap: 1, rate: 40 }],
  due_orders: [{ order_id: 'po1', order_number: 'PRD-000001', sku: 'MOCK-WC-1', unit: 'PCS', status: 'IN_PROGRESS', target_date: TODAY, planned: 10, good: 4 }],
  output: [{ unit: 'PCS', good: 4, rejected: 0, scrap: 1 }], output_by_month: [{ month: monthStart, unit: 'PCS', good: 4, rejected: 0, scrap: 1 }],
  material_outlook: [{ product_id: 'p4', sku: 'MOCK-GLZ', product_name: 'Mock glaze', unit: 'KG', warehouse: 'MAIN', orders: 1, outstanding: 2.2, reserved_for_orders: 0, available: 20, shortage: 0, order_numbers: 'PRD-000001' }],
  shortage_materials: 0, consumption_by_order: [{ order_id: 'po1', order_number: 'PRD-000001', product_sku: 'MOCK-WC-1', unit: 'KG', quantity: 25, planned: 25, issues: 1 }],
  overdue_orders: [], overdue_count: 0,
  outsourcing: has('outsourcing.read') ? { available: true, by_status: [{ status: 'MATERIALS_DISPATCHED', orders: 1 }], held_by_suppliers: [{ supplier: 'Mock Ceramics', sku: 'MOCK-CLAY', unit: 'KG', quantity: 10 }],
    external_stock: [{ unit: 'KG', on_hand: 10 }], flows: [{ unit: 'KG', dispatched: 10, returned: 0 }], received: [], awaiting_receipt: [{ unit: 'PCS', quantity: 6 }],
    lead_time: { orders: 0, average_days: null, definition: 'Days from material dispatch date to completion of the outsourcing order.' }, overdue: [], suppliers: ['Mock Ceramics'] } : na('outsourcing.read'),
  generated_at: NOW,
})
const ANALYTICS_FULFILMENT = (body) => ({
  from: body.p_from, to: body.p_to, generated_at: NOW,
  purchase_orders: has('customer_po.read') ? { available: true, has_records: true, imported: 1, awaiting_validation: 0, unresolved_mappings: 1, ready_for_fulfilment: 1, partially_allocated: 0,
    fully_allocated: 0, with_shortages: 0, converted_to_sales_orders: 1, by_status: [{ status: 'READY_FOR_ALLOCATION', count: 1 }] } : na('customer_po.read'),
  sales_orders: has('sales_orders.read') ? { available: true, has_records: true, awaiting_confirmation: 1, awaiting_allocation: 0, awaiting_picking: 1, awaiting_packing: 0, awaiting_dispatch: 1,
    partially_dispatched: 1, on_hold: 0, completed_in_period: 0, orders_in_period: 2, fully_dispatched_in_period: 0, fulfilment_rate: 0,
    units: [{ unit: 'PCS', ordered: 6, dispatched: 2, rate: 33.3 }], by_status: [{ status: 'IN_FULFILMENT', count: 1 }] } : na('sales_orders.read'),
})
const ANALYTICS_SHORTAGES = (body) => ({
  available: true, sources: { sales_orders: true, purchase_orders: true }, total: 1,
  rows: [{ source: 'SALES_ORDER', customer_po_number: 'ACME-77', sales_order_number: 'SO-000001', sales_order_id: 'so1', purchase_order_id: 'cpo1', customer: 'Acme Ltd', product_id: 'p1',
    sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', ordered: 5, dispatched: 2, reserved: 0, available: 0, remaining_required: 3, shortage: 3, in_house: 0, outsourced: 0,
    next_action: 'review replenishment (no BOM)' }].slice(body.p_offset, body.p_offset + body.p_limit),
  product_totals: [{ product_id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', required: 3, available: 0, net_shortage: 3, lines: 1 }],
  definition: 'Remaining required = ordered - dispatched - reserved.', generated_at: NOW,
})
const ANALYTICS_FINANCE = (body) => ({
  from: body.p_from, to: body.p_to, as_of: body.p_as_of ?? TODAY, currency: 'INR', has_records: true,
  totals: { invoices: 1, invoiced: 2242, invoiced_taxable: 1900, collected: 1221, receipts: 1, reversed_receipts: 0, allocated_in_period: 1121, outstanding: 1121, overdue: 0,
    customer_credits: 0, credit_notes: 0, debit_notes: 0, unallocated: 100 },
  collection_rate: { allocated: 1121, open_at_end: 1121, percent: 50, definition: 'Receipts allocated to invoices in the period ÷ (those allocations + balances still open at the end of the period).' },
  collection_time: { invoices: 0, average_days: null, definition: 'Average days from invoice date to the allocation that settled it.' },
  monthly: [{ month: monthStart, invoiced: 2242, invoices: 1, collected: 1221, credit_notes: 0, debit_notes: 0 }],
  ageing: [{ bucket: 'NOT_DUE', amount: 1121, invoices: 1 }, { bucket: '1_30', amount: 0, invoices: 0 }, { bucket: '31_60', amount: 0, invoices: 0 }, { bucket: '61_90', amount: 0, invoices: 0 }, { bucket: 'OVER_90', amount: 0, invoices: 0 }],
  by_customer: [{ customer_id: 'cu1', customer: 'Acme Ltd', balance: 1121, overdue: 0, invoices: 1, oldest_days_overdue: 0 }], customers_with_balance: 1, top_overdue: [],
  upcoming_due: [{ invoice_id: 'inv2', invoice_number: 'INV/26-27/0001', customer: 'Acme Ltd', due_date: TODAY, balance: 1121, days_to_due: 0 }], upcoming_due_total: 1121,
  notes_by_reason: [], unallocated_receipts: has('payments.read') ? [{ payment_id: 'pay1', receipt_number: 'RCT/26-27/0001', receipt_date: TODAY, customer: 'Acme Ltd', amount: 1221, unallocated: 100 }] : null,
  unavailable_metrics: [{ metric: 'Profit and gross margin', reason: 'Needs a verified cost of goods sold for every invoiced line.' },
    { metric: 'Net income', reason: 'The ERP has no general ledger.' }, { metric: 'Cash flow', reason: 'Only customer receipts are recorded.' }],
  generated_at: NOW,
})
const ANALYTICS_ALERTS = () => ({
  as_of: TODAY, today: TODAY, limit_per_rule: 100, generated_at: NOW,
  skipped: has('billing_reports.read') ? [] : ['Receivable alerts need billing_reports.read'],
  counts: { HIGH: 1, MEDIUM: 1 },
  alerts: [
    { id: 'SO_SHORTAGE:so1', type: 'SO_SHORTAGE', severity: 'HIGH', team: 'SALES', title: 'Stock shortage on an open order', reference: 'SO-000001', record_id: 'so1', detected_at: TODAY,
      explanation: 'MOCK-WC-1 short by 3 PCS', action: 'Allocate stock when it arrives or plan replenishment.', link: '/sales/order-details?so=so1' },
    ...(has('payments.read') ? [{ id: 'PAYMENT_UNALLOCATED:pay1', type: 'PAYMENT_UNALLOCATED', severity: 'MEDIUM', team: 'ACCOUNTS', title: 'Receipt not fully allocated', reference: 'RCT/26-27/0001 · Acme Ltd',
      record_id: 'pay1', detected_at: TODAY, explanation: '100.00 of 1,221.00 is not allocated to any invoice.', action: 'Allocate it to open invoices.', link: '/billing/payments?receipt=pay1' }] : []),
  ],
})
const ANALYTICS_DQ = () => ({
  issues: 1, note: 'Checks are read-only. Nothing is corrected or deleted from here.', generated_at: NOW,
  checks: [
    { code: 'STOCK_LEDGER', module: 'Inventory', title: 'Stock balances that differ from the ledger', rule: 'On hand equals the sum of posted ledger transactions.', issues: 0, samples: [] },
    { code: 'UNKNOWN_SOURCE', module: 'Inventory', title: 'Stock without in-house / outsourced attribution', rule: 'Stock on hand has a verified source.', issues: 1,
      samples: [{ reference: 'MOCK-WC-1 @ GENERAL', record_id: 'p1', link: '/inventory/stock/p1', detail: '5 PCS with source UNKNOWN' }] },
  ],
})

const PRODUCTION_OVERVIEW = {
  has_records: true, open_orders: 2, draft_orders: 0, in_progress_orders: 1, on_hold_orders: 0, overdue_orders: 0, completed_orders: 0,
  planned_open: [{ unit: 'PCS', planned: 20, remaining: 16 }], produced_this_month: [{ unit: 'PCS', good: 4, rejected: 0, scrap: 0 }],
  produced_in_period: [{ unit: 'PCS', good: 4, rejected: 0, scrap: 0 }], shortage_materials: 1, outsourcing_in_progress: 1,
  pending_order_approvals: 1, pending_bom_approvals: 1, pending_outsourcing_approvals: 0,
  planned_vs_actual: [{ bucket: TODAY, unit: 'PCS', planned: 10, actual: 4 }], by_product: [{ sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', good: 4, rejected: 0, scrap: 0 }],
  by_status: [{ status: 'IN_PROGRESS', orders: 1 }, { status: 'PENDING_APPROVAL', orders: 1 }], source_split: [{ bucket: TODAY, unit: 'PCS', in_house: 4, outsourced: 0 }],
  consumption_trend: [{ bucket: TODAY, unit: 'KG', quantity: 25 }],
  shortages: [{ sku: 'MOCK-CLAY', product_name: 'Mock ceramic body', unit: 'KG', warehouse_code: 'MAIN', outstanding: 25, available: 0, reserved_for_orders: 0, shortage: 25, orders: 1 }],
  timezone: 'Asia/Kolkata', today: TODAY, as_of: NOW,
}
const requirementLine = (line, productId, sku, name, total, available) => ({
  line_no: line, component_product_id: productId, sku, product_name: name, product_type: 'RAW_MATERIAL', unit: 'KG', inventory_unit: 'KG', quantity_per_unit: 2.5,
  wastage_percentage: 0, base_requirement: total, wastage_allowance: 0, total_requirement: total, on_hand: available, reserved: 0, available,
  shortage: Math.max(total - available, 0), suggested_quantity: Math.max(total - available, 0), reorder_level: null,
  line_status: available >= total ? 'SUFFICIENT' : available > 0 ? 'PARTIAL' : 'SHORTAGE', message: null,
})
const ORDER_REQUIREMENTS = [
  { order_material_id: 'pm1', line_no: 1, component_product_id: 'p3', sku: 'MOCK-CLAY', product_name: 'Mock ceramic body', unit: 'KG', inventory_unit: 'KG', quantity_per_unit: 2.5,
    wastage_percentage: 0, base_quantity: 25, planned_quantity: 25, issued_quantity: 25, outstanding_quantity: 0, reserved_for_order: 0, available_in_source: 75, shortage: 0, line_status: 'ISSUED' },
  { order_material_id: 'pm2', line_no: 2, component_product_id: 'p4', sku: 'MOCK-GLZ', product_name: 'Mock glaze', unit: 'KG', inventory_unit: 'KG', quantity_per_unit: 0.2,
    wastage_percentage: 10, base_quantity: 2, planned_quantity: 2.2, issued_quantity: 0, outstanding_quantity: 2.2, reserved_for_order: 0, available_in_source: 20, shortage: 0, line_status: 'SUFFICIENT' },
]

// --- Amazon Intelligence mock data (test process only; demo mode only) -----
const AMZ_SETTINGS = { company_id: COMPANY_ID, prices_include_gst: true, attribution_window_days: 7, min_clicks_for_decision: 20, min_orders_for_scaling: 3, wasted_spend_threshold: 500,
  low_stock_cover_days: 14, overstock_cover_days: 120, target_contribution_pct: 10, overhead_allocation_pct: 0, automation_mode: 'READ_ONLY', kill_switch: true, max_daily_budget: null,
  max_monthly_budget: null, max_bid: null, max_bid_change_pct: 30, max_budget_change_pct: 30 }
const amzConn = (api) => ({ company_id: COMPANY_ID, api, status: 'NOT_CONFIGURED', account_identifier: null, account_name: null, region: null, marketplace_ids: [], profile_id: null, permissions: [],
  last_test_at: null, last_test_ok: null, last_test_message: null, last_successful_sync_at: null, last_error_at: null, last_error_message: null, updated_at: NOW })
const amzProduct = (sku, title, units, sales, spend, adSales, stock) => ({
  seller_sku: sku, listing_id: `l-${sku}`, asin: 'B0DEMO0001', title, marketplace_id: 'A21TJRUUN4KGV', product_id: null, erp_sku: null, erp_name: null, category: 'Wash Basins',
  item_price: Math.round(sales / Math.max(units, 1)), fulfillment_channel: 'MFN', listing_status: 'Active', advertising_status: 'ADVERTISED', data_source: 'DEMO', gst_rate: 18, gst_source: 'LISTING',
  unit_cost: 900, cost_source: 'LISTING_OVERRIDE', costs_updated_at: NOW, referral_fee_pct: 10, closing_fee_per_unit: 20, fulfilment_fee_per_unit: 80, shipping_cost_per_unit: null,
  other_variable_cost_per_unit: null, desired_contribution_per_unit: null, target_acos_pct: null, min_stock: null, lead_time_days: 21,
  totals: { ordered_sales: sales, units, order_items: units, sessions: units * 12, sales_ex_gst: Math.round(sales / 1.18), refunds_ex_gst: 0, discounts_ex_gst: 0, gst_missing: false,
    actual_referral: null, actual_fulfilment: null, actual_other: null, est_referral: Math.round(sales * 0.1), est_fulfilment: units * 100, fee_missing_days: 0, shipping_cost: null,
    other_variable_cost: null, product_cost: units * 900, units_without_cost: 0, ad_spend: spend, ad_sales: adSales, ad_orders: Math.round(adSales / 2400), ad_clicks: Math.round(spend / 12),
    ad_impressions: Math.round(spend * 40), sales_days: 30 },
  stock: { erp_available: null, erp_as_of: null, amazon_fulfillable: stock, amazon_inbound: 0, amazon_as_of: NOW, amazon_source: 'DEMO', incoming_production: null },
  velocity: { units_7: Math.round(units / 4), units_28: units, units_56: units * 2, days_with_data_28: 28, daily_28: Array(28).fill(units / 28) }, campaigns: ['DEMO-C1'],
})
const AMZ_PRODUCTS = [amzProduct('DEMO-BASIN-01', 'Demo wall-hung basin', 60, 144000, 9000, 48000, 400), amzProduct('DEMO-WC-02', 'Demo one-piece closet', 12, 108000, 15000, 18000, 6)]
const AMZ_CAMPAIGNS = [
  { campaign_id: 'DEMO-C1', profile_id: 'DEMO', name: 'Demo - Basins exact', ad_product: 'SPONSORED_PRODUCTS', targeting_type: 'MANUAL', state: 'ENABLED', daily_budget: 400, data_source: 'DEMO',
    last_synced_at: NOW, impressions: 360000, clicks: 750, spend: 9000, sales: 48000, orders: 20, units: 20, days_with_data: 30, budget_total: 12000, budget_constrained_days: 12,
    zero_order_target_spend: 800, products: ['DEMO-BASIN-01'] },
  { campaign_id: 'DEMO-C2', profile_id: 'DEMO', name: 'Demo - Closets auto', ad_product: 'SPONSORED_PRODUCTS', targeting_type: 'AUTO', state: 'ENABLED', daily_budget: 500, data_source: 'DEMO',
    last_synced_at: NOW, impressions: 600000, clicks: 1250, spend: 15000, sales: 18000, orders: 2, units: 2, days_with_data: 30, budget_total: 15000, budget_constrained_days: 0,
    zero_order_target_spend: 6000, products: ['DEMO-WC-02'] },
]
const AMZ_TERMS = [
  { campaign_id: 'DEMO-C2', campaign_name: 'Demo - Closets auto', targeting_type: 'AUTO', ad_group_id: 'DEMO-AG2', ad_group_name: 'Auto', targeting: 'close-match', match_type: null,
    search_term: 'cheap toilet seat', target_id: null, bid: null, impressions: 20000, clicks: 90, spend: 1100, sales: 0, orders: 0, units: 0, days: 20, asin: null, seller_sku: 'DEMO-WC-02',
    exact_exists: false, negative_exists: false },
  { campaign_id: 'DEMO-C1', campaign_name: 'Demo - Basins exact', targeting_type: 'MANUAL', ad_group_id: 'DEMO-AG1', ad_group_name: 'Exact', targeting: 'wall basin', match_type: 'BROAD',
    search_term: 'wall hung wash basin', target_id: 'DEMO-T1', bid: 12, impressions: 30000, clicks: 120, spend: 1400, sales: 12000, orders: 5, units: 5, days: 20, asin: null, seller_sku: 'DEMO-BASIN-01',
    exact_exists: false, negative_exists: false },
]
const amzStatus = (demo) => ({ demo, listings: demo ? 2 : 0, mapped_listings: 0, sales_days: demo ? 30 : 0, fee_days: 0, campaign_days: demo ? 30 : 0, ad_product_days: demo ? 30 : 0,
  search_term_days: demo ? 30 : 0, inventory_snapshot_at: demo ? NOW : null, last_sales_date: demo ? TODAY : null, last_ads_date: demo ? TODAY : null, period_days: 30,
  connections: [amzConn('SP_API'), amzConn('ADS_API')] })
const amzDays = () => Array.from({ length: 10 }, (_, i) => ({ date: new Date(Date.now() - (9 - i) * 86400000).toISOString().slice(0, 10),
  components: { ordered_sales: 8000, units: 3, sales_ex_gst: 6780, refunds_ex_gst: 0, discounts_ex_gst: 0, gst_missing: false, est_referral: 800, est_fulfilment: 300, fee_missing_days: 0,
    product_cost: 2700, units_without_cost: 0, ad_spend: 800, ad_sales: 2200, ad_orders: 1, ad_clicks: 65, ad_impressions: 32000, sales_days: 1 },
  account_ads: { spend: 800, sales: 2200, orders: 1, clicks: 65, impressions: 32000, budget: 900, rows: 2 } }))
Object.assign(tables, { amazon_settings: [AMZ_SETTINGS], amazon_connections: [amzConn('ADS_API'), amzConn('SP_API')], amazon_listings: [], amazon_recommendations: [],
  amazon_budget_plans: [], amazon_ad_change_requests: [], amazon_sync_jobs: [], amazon_sync_errors: [] })
const supplierRow = (id, code, over = {}) => ({ id, company_id: COMPANY_ID, supplier_code: code, legal_name: code, display_name: null, category: 'RAW_MATERIAL',
  contact_person: null, phone: null, alternate_phone: null, email: null, gstin: null, pan: null, billing_address: null, shipping_address: null, city: null,
  state_code: null, pin_code: null, country: 'India', payment_terms: 'DAYS_30', custom_payment_days: null, notes: null, status: 'ACTIVE', ...stamp, ...over })
Object.assign(tables, { suppliers: [
  supplierRow('sup1', 'SUP-000001', { legal_name: 'Shree Clay Works Pvt Ltd', display_name: 'Shree Clay', contact_person: 'R. Patil', phone: '+91 98200 12345',
    email: 'sales@shreeclay.example', gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F', billing_address: 'Plot 4, MIDC\nBhosari', city: 'Pune', state_code: '27', pin_code: '411026' }),
  supplierRow('sup2', 'PACK-01', { legal_name: 'Box & Carton Co.', category: 'PACKAGING', status: 'INACTIVE', state_code: '29', payment_terms: 'CUSTOM', custom_payment_days: 60 }),
] })
// V2 Stage 2: unified ledger fixtures.
const ledgerParty = (over) => ({ party_id: 'pty1', party_code: 'PTY-000001', party_type: 'CUSTOMER', party_name: 'Acme Ltd', legal_name: null, status: 'ACTIVE',
  customer_id: 'cu1', customer_code: 'C-ACME', customer_status: 'ACTIVE', supplier_id: null, supplier_code: null, supplier_status: null, supplier_category: null,
  gstin: null, pan: null, gst_registration_type: null, contact_person: null, phone: null, email: null, billing_address: null, shipping_address: null, city: 'Pune',
  state_code: '27', state_name: 'Maharashtra', shipping_state_code: null, pin_code: null, country: 'India', credit_period_days: 30, payment_terms: 'DAYS_30',
  payment_terms_note: null, opening_balance: 0, opening_balance_type: null, opening_balance_date: null, bank_name: null, bank_account_name: null,
  bank_account_number: null, bank_ifsc: null, remarks: null, receivable: 7080, payable: 0, net_balance: 7080, overdue: 0, last_activity: TODAY, created_at: NOW, updated_at: NOW, ...over })
const LEDGER_PARTIES = [
  ledgerParty({}),
  ledgerParty({ party_id: 'pty-sup1', party_code: 'PTY-000002', party_type: 'SUPPLIER', party_name: 'Shree Clay', customer_id: null, customer_code: null, customer_status: null,
    supplier_id: 'sup1', supplier_code: 'SUP-000001', supplier_status: 'ACTIVE', gstin: '27AAPFU0939F1ZV', phone: '+91 98200 12345', receivable: 0, payable: 756, net_balance: -756 }),
  ledgerParty({ party_id: 'pty3', party_code: 'PTY-000003', party_type: 'BOTH', party_name: 'Aqua Fittings LLP', supplier_id: 'sup9', supplier_code: 'SUP-000009',
    supplier_status: 'ACTIVE', receivable: 700, payable: 256, net_balance: 444, opening_balance: 1000, opening_balance_type: 'RECEIVABLE', opening_balance_date: TODAY }),
]
const LEDGER_ENTRIES = [
  { date: TODAY, kind: 'SUPPLIER_PAYMENT', document: 'SPAY-000001', ref_id: 'sp1', description: 'Payment made (bank transfer)', status: 'RECORDED', amount: 500, receivable: 0, payable: -500, receivable_balance: 700, payable_balance: 256 },
  { date: TODAY, kind: 'GOODS_RECEIPT', document: 'GRN-000001', ref_id: 'gr1', description: 'Goods received', status: 'POSTED', amount: 756, receivable: 0, payable: 756, receivable_balance: 700, payable_balance: 756 },
  { date: TODAY, kind: 'RECEIPT', document: 'RCPT-1', ref_id: 'rc1', description: 'Payment received (upi)', status: 'RECORDED', amount: 300, receivable: -300, payable: 0, receivable_balance: 700, payable_balance: 0 },
  { date: TODAY, kind: 'OPENING', document: 'PTY-000003', ref_id: 'pty3', description: 'Opening balance (receivable)', status: null, amount: 1000, receivable: 1000, payable: 0, receivable_balance: 1000, payable_balance: 0 },
]
tables.companies[0].gstin = '27AAACT1234A1Z5'
// --- Supplier purchase orders (mock) ----------------------------------------
const spoRow = (id, n, status, over = {}) => ({
  id, company_id: COMPANY_ID, po_number: `PO-00000${n}`, revision: 0, status, supplier_id: 'sup1', supplier_code: 'SUP-000001', supplier_name: 'Shree Clay Works Pvt Ltd',
  supplier_gstin: '27AAPFU0939F1ZV', supplier_pan: 'AAPFU0939F', supplier_state_code: '27', supplier_country: 'India', supplier_billing_address: 'Plot 4, MIDC\nBhosari',
  supplier_shipping_address: null, supplier_contact_person: 'R. Patil', supplier_email: 'sales@shreeclay.example', supplier_phone: '+91 98200 12345',
  buyer_legal_name: 'Test Co', buyer_address: 'Plot 1, Pune', buyer_gstin: '27AAACT1234A1Z5', place_of_supply_state_code: '27', tax_treatment: 'INTRA_STATE',
  po_date: TODAY, expected_delivery_date: TODAY, warehouse_id: 'w1', warehouse_code: 'MAIN', warehouse_name: 'Mock main store', delivery_address: 'Gate 2',
  purchase_type: 'FINISHED_GOODS', currency_code: 'INR', payment_terms: 'DAYS_30', custom_payment_days: null, payment_terms_overridden: false, reference_number: null,
  delivery_instructions: null, internal_notes: null, purchase_conditions: null, gross_total: 10000, discount_total: 1000, taxable_total: 9000, other_charges_total: 0,
  cgst_total: 810, sgst_total: 810, igst_total: 0, round_off: 0, grand_total: 10620, submitted_by: null, submitted_at: null, approved_by: null, approved_at: null,
  rejected_by: null, rejected_at: null, rejection_reason: null, sent_by: null, sent_at: null, cancelled_by: null, cancelled_at: null, cancel_reason: null,
  closed_by: null, closed_at: null, close_reason: null, created_by: MANAGER_ID, updated_by: MANAGER_ID, created_at: NOW, updated_at: '2026-10-20T10:00:00.123456+00:00',
  line_count: 1, total_ordered_quantity: 10, total_received_quantity: 0, total_accepted_quantity: 0, total_pending_quantity: 10, pending_value: 10620,
  skus: 'MOCK-WC-1', product_ids: ['p1'], receipt_count: 0, ...over,
})
const spoLine = (id, po, no, over = {}) => ({
  id, company_id: COMPANY_ID, purchase_order_id: po, line_no: no, line_type: 'GOODS', product_id: 'p1', sku: 'MOCK-WC-1', description: 'Mock Closet 1', hsn_sac: '6910',
  unit: 'PCS', ordered_quantity: 10, unit_price: 1000, master_cost_snapshot: null, discount_percent: 10, discount_value_input: 0, gross_amount: 10000, discount_amount: 1000,
  taxable_value: 9000, gst_rate: 18, cgst_rate: 9, sgst_rate: 9, igst_rate: 0, cgst_amount: 810, sgst_amount: 810, igst_amount: 0, line_total: 10620,
  created_at: NOW, updated_at: NOW, received_quantity: 0, accepted_quantity: 0, rejected_quantity: 0, pending_quantity: 10, pending_value: 10620, ...over,
})
const pvRow = (id, receipt, number, over = {}) => ({
  goods_receipt_line_id: id, company_id: COMPANY_ID, goods_receipt_id: receipt, receipt_number: number, receipt_date: TODAY, receipt_status: 'POSTED', supplier_id: 'sup1',
  supplier_name: 'Shree Clay Works Pvt Ltd', purchase_order_id: 'po3', po_number: 'PO-000003', po_line_no: 1, product_id: 'p1', sku: 'MOCK-WC-1', description: 'Mock Closet 1',
  line_type: 'GOODS', received_quantity: over.accepted_quantity ?? 1, rejected_quantity: 0, po_unit_cost: null, actual_unit_cost: null, payable_value: null,
  price_variance_reason: null, price_recorded: true, received_by: MANAGER_ID, received_at: NOW, ...over,
})
Object.assign(tables, {
  purchase_order_list: [
    spoRow('po1', 1, 'DRAFT'),
    spoRow('po2', 2, 'PENDING_APPROVAL', { created_by: VIEWER_ID, submitted_by: VIEWER_ID, submitted_at: NOW, grand_total: 11800, supplier_name: 'Morbi Tiles LLP', skus: 'MOCK-CLAY' }),
    spoRow('po3', 3, 'SENT', { created_by: VIEWER_ID, approved_by: VIEWER_ID, approved_at: NOW, sent_by: VIEWER_ID, sent_at: NOW, total_received_quantity: 2,
      total_accepted_quantity: 2, total_pending_quantity: 8, pending_value: 8496, receipt_count: 1, line_count: 2 }),
  ],
  purchase_order_line_list: [
    spoLine('pol1', 'po1', 1), spoLine('pol2', 'po2', 1, { product_id: 'p3', sku: 'MOCK-CLAY', unit: 'KG' }),
    spoLine('pol3a', 'po3', 1, { received_quantity: 2, accepted_quantity: 2, pending_quantity: 8, pending_value: 8496 }),
    spoLine('pol3b', 'po3', 2, { line_type: 'CHARGE', product_id: null, sku: null, description: 'Freight', unit: 'NOS', ordered_quantity: 1, unit_price: 0, gross_amount: 0,
      discount_amount: 0, discount_percent: null, taxable_value: 0, cgst_amount: 0, sgst_amount: 0, line_total: 0, pending_quantity: 0, pending_value: 0 }),
  ],
  goods_receipt_list: [{ id: 'gr1', company_id: COMPANY_ID, receipt_number: 'GRN-000001', purchase_order_id: 'po3', po_revision: 0, supplier_id: 'sup1', warehouse_id: 'w1',
    receipt_date: TODAY, supplier_document_number: 'DC-554', supporting_document_ref: null, notes: null, status: 'POSTED', reversal_transaction_ids: null, reversal_reason: null,
    reversed_by: null, reversed_at: null, created_by: MANAGER_ID, created_at: NOW, po_number: 'PO-000003', supplier_name: 'Shree Clay Works Pvt Ltd', supplier_code: 'SUP-000001',
    warehouse_code: 'MAIN', line_count: 1, total_received: 2, total_accepted: 2, total_rejected: 0, receipt_type: 'PURCHASE_ORDER', corrects_receipt_id: null },
  { id: 'gr9', company_id: COMPANY_ID, receipt_number: 'GRN-000009', purchase_order_id: null, po_revision: null, supplier_id: null, warehouse_id: 'w1',
    receipt_date: TODAY, supplier_document_number: 'CH-77', supporting_document_ref: null, notes: null, status: 'POSTED', reversal_transaction_ids: null, reversal_reason: null,
    reversed_by: null, reversed_at: null, created_by: MANAGER_ID, created_at: NOW, po_number: null, supplier_name: null, supplier_code: null,
    warehouse_code: 'MAIN', line_count: 1, total_received: 3, total_accepted: 3, total_rejected: 0, receipt_type: 'DIRECT', corrects_receipt_id: null }],
  goods_receipt_price_variance: [
    // Posted before prices were recorded: no snapshot, so no prices (never the current PO price).
    pvRow('pv1', 'gr1', 'GRN-000001', { po_unit_price: null, actual_unit_price: null, price_difference: null, variance_percent: null, accepted_quantity: 2, accepted_value: null, accepted_value_at_po: null, price_recorded: false }),
    pvRow('pv2', 'gr2', 'GRN-000002', { po_unit_price: 1000, po_unit_cost: 900, actual_unit_price: 1250, actual_unit_cost: 1125, price_difference: 250, variance_percent: 25, accepted_quantity: 4,
      accepted_value: 4500, accepted_value_at_po: 3600, payable_value: 5310, price_variance_reason: 'Supplier price revision' }),
    pvRow('pv3', 'gr3', 'GRN-000003', { supplier_id: 'sup2', supplier_name: 'Morbi Tiles LLP', product_id: 'p3', sku: 'MOCK-CLAY', description: 'Mock Clay', po_unit_price: 50, po_unit_cost: 50,
      actual_unit_price: 45, actual_unit_cost: 45, price_difference: -5, variance_percent: -10, accepted_quantity: 10, accepted_value: 450, accepted_value_at_po: 500, payable_value: 531,
      price_variance_reason: 'Negotiated price change' }),
    pvRow('pv4', 'gr4', 'GRN-000004', { receipt_status: 'REVERSED', po_unit_price: 1000, po_unit_cost: 900, actual_unit_price: 1500, actual_unit_cost: 1350, price_difference: 500, variance_percent: 50,
      accepted_quantity: 1, accepted_value: 1350, accepted_value_at_po: 900, payable_value: 1593, price_variance_reason: 'Other: test' }),
  ],
  goods_receipt_line_list: [{ id: 'grl1', company_id: COMPANY_ID, goods_receipt_id: 'gr1', purchase_order_id: 'po3', purchase_order_line_id: 'pol3a', line_type: 'GOODS',
    product_id: 'p1', unit: 'PCS', received_quantity: 2, accepted_quantity: 2, rejected_quantity: 0, inspection_status: 'ACCEPTED', rejection_reason: null,
    accepted_location_id: 'l1', rejected_location_id: null, batch_id: null, batch_number: null, manufacturing_date: null, expiry_date: null, serial_numbers: null,
    unit_cost: 900, accepted_transaction_id: 't9', rejected_transaction_id: null, over_receipt_reason: null, created_at: NOW, receipt_number: 'GRN-000001',
    receipt_date: TODAY, receipt_status: 'POSTED', supplier_document_number: 'DC-554', po_line_no: 1, sku: 'MOCK-WC-1', description: 'Mock Closet 1', ordered_quantity: 10,
    accepted_location_code: 'GENERAL', rejected_location_code: null, accepted_transaction_number: 'TXN-000090', rejected_transaction_number: null, gst_rate: null, line_value: null },
  { id: 'grl9', company_id: COMPANY_ID, goods_receipt_id: 'gr9', purchase_order_id: null, purchase_order_line_id: null, line_type: 'GOODS',
    product_id: 'p1', unit: 'PCS', received_quantity: 3, accepted_quantity: 3, rejected_quantity: 0, inspection_status: 'ACCEPTED', rejection_reason: null,
    accepted_location_id: 'l1', rejected_location_id: null, batch_id: null, batch_number: null, manufacturing_date: null, expiry_date: null, serial_numbers: null,
    unit_cost: 900, accepted_transaction_id: 't95', rejected_transaction_id: null, over_receipt_reason: null, created_at: NOW, receipt_number: 'GRN-000009',
    receipt_date: TODAY, receipt_status: 'POSTED', supplier_document_number: 'CH-77', po_line_no: null, sku: 'MOCK-WC-1', description: 'Mock Closet 1', ordered_quantity: null,
    accepted_location_code: 'GENERAL', rejected_location_code: null, accepted_transaction_number: 'TXN-000095', rejected_transaction_number: null, gst_rate: 18, line_value: 3186 }],
  purchase_order_events: [{ id: 'pe1', company_id: COMPANY_ID, purchase_order_id: 'po3', event_type: 'APPROVED', from_status: 'PENDING_APPROVAL', to_status: 'APPROVED',
    note: null, details: {}, actor_user_id: VIEWER_ID, created_at: NOW }],
  purchase_order_amendments: [],
})
// V2 lists with the supplier invoice / challan references.
Object.defineProperty(tables, 'purchase_order_list_v2', { enumerable: true, get: () => tables.purchase_order_list.map((o) => ({ ...o,
  supplier_invoice_number: o.id === 'po3' ? 'SINV-778' : null, supplier_challan_number: o.id === 'po3' ? 'SDC-12' : null,
  receipt_invoice_numbers: o.id === 'po3' ? 'SINV-778' : null, receipt_challan_numbers: o.id === 'po3' ? 'DC-554' : null })) })
Object.defineProperty(tables, 'purchase_order_list_excl_gst', { enumerable: true, get: () => tables.purchase_order_list_v2.map((o) => ({ ...o,
  pending_taxable_value: Math.round(Number(o.pending_value ?? 0) / 1.18 * 100) / 100 })) })
Object.defineProperty(tables, 'sales_invoice_list_excl_gst', { enumerable: true, get: () => tables.sales_invoice_list.map((i) => ({ ...i,
  outstanding_excl_gst: i.status !== 'ISSUED' ? null : Number(i.paid ?? 0) > 0 && Number(i.balance_due) > 0 ? null : Number(i.balance_due) > 0 ? Number(i.taxable_subtotal ?? 0) : 0,
  excl_gst_status: i.status !== 'ISSUED' ? null : Number(i.balance_due) <= 0 ? 'SETTLED' : Number(i.paid ?? 0) > 0 ? 'REVIEW' : 'EXACT' })) })
Object.defineProperty(tables, 'goods_receipt_list_v2', { enumerable: true, get: () => tables.goods_receipt_list.map((r) => ({ ...r,
  supplier_invoice_number: r.id === 'gr1' ? 'SINV-778' : null, supplier_challan_number: r.id === 'gr1' ? 'DC-554' : null })) })
// Day-based reorder planning (inventory_reorder_plan).
const planRow = (over) => ({ product_id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', product_type: 'FINISHED_GOOD', on_hand: 140, reserved: 10,
  available: 130, incoming: 0, open_orders: 0, consumed: 90, observed_days: 90, limited_history: false, avg_daily: 1, coverage_days: 130, coverage_with_incoming_days: 130,
  lead_time_days: 7, reorder_level_days: 30, legacy_reorder_quantity: 10, runs_out_within_lead_time: false, status: 'OK', suggested_quantity: null, ...over })
const REORDER_PLAN = (body) => ({ history_days: body.p_history_days ?? 90, as_of: NOW, summary: { reorder: 1, ok: 1, no_consumption: 0, not_configured: 1 }, rows: [
  planRow({ product_id: 'p3', sku: 'MOCK-CLAY', product_name: 'Mock ceramic body', unit: 'KG', product_type: 'RAW_MATERIAL', on_hand: 40, reserved: 7.5, available: 32.5,
    incoming: 20, open_orders: 1, avg_daily: 1, coverage_days: 32.5, coverage_with_incoming_days: 52.5, lead_time_days: 14, reorder_level_days: 45, legacy_reorder_quantity: 40,
    status: 'REORDER', suggested_quantity: 6.5 }),
  planRow({}),
  planRow({ product_id: 'p4', sku: 'MOCK-GLZ', product_name: 'Mock glaze', unit: 'KG', product_type: 'RAW_MATERIAL', on_hand: 0, reserved: 0, available: 0, consumed: 0,
    avg_daily: null, coverage_days: null, coverage_with_incoming_days: null, lead_time_days: null, reorder_level_days: null, legacy_reorder_quantity: null, status: 'NOT_CONFIGURED' }),
] })
/** Minimal PostgREST-style filtering: col=eq.x and col=in.(a,b). */
// PostgREST logic trees ("or=(a.is.null,and(b.eq.X,c.is.null))"): enough of the grammar for the ERP's filters.
function splitTop(s) {
  const parts = []
  let depth = 0, quoted = false, cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && quoted) { cur += ch + s[++i]; continue }
    if (ch === '"') quoted = !quoted
    if (!quoted && ch === '(') depth++
    if (!quoted && ch === ')') depth--
    if (!quoted && ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur) parts.push(cur)
  return parts
}
function logicTerm(row, term) {
  const m = /^(or|and)\((.*)\)$/s.exec(term)
  if (m) return m[1] === 'or' ? splitTop(m[2]).some((t) => logicTerm(row, t)) : splitTop(m[2]).every((t) => logicTerm(row, t))
  const [, col, not, op, raw] = /^([a-z_.]+)\.(not\.)?(eq|neq|is|ilike|gt|lt|gte|lte)\.(.*)$/s.exec(term) ?? []
  if (!col) return true
  const value = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw
  const v = row[col]
  let r
  if (op === 'is') r = value === 'null' ? v === null || v === undefined : String(v) === value
  else if (op === 'eq') r = String(v) === value
  else if (op === 'neq') r = v !== null && v !== undefined && String(v) !== value
  else if (op === 'ilike') r = v !== null && v !== undefined && String(v).toLowerCase().includes(value.replace(/^%|%$/g, '').replace(/\\(.)/g, '$1').toLowerCase())
  else r = true
  return not ? !r : r
}

/** The ERP search rule for mocked search RPCs: every word (case-insensitive) somewhere in the row's text or its related rows. */
function mockSearch(rows, search, related = () => []) {
  const words = [...new Set(String(search ?? '').toLowerCase().split(/\s+/).filter(Boolean))]
  const text = (r) => Object.values(r).filter((v) => typeof v === 'string').join(' ')
  return rows.filter((r) => { const hay = [r, ...related(r)].map(text).join(' ').toLowerCase(); return words.every((w) => hay.includes(w)) })
}

/** p_status of the search RPCs: null = all, ACTIVE = not archived, OPEN = not completed / cancelled, else that status. */
const mockStatus = (rows, st) => rows.filter((r) => !st || (st === 'ACTIVE' ? r.status !== 'ARCHIVED' : st === 'OPEN' ? !['COMPLETED', 'CANCELLED'].includes(r.status) : r.status === st))

function filterRows(rows, params) {
  let out = rows
  for (const [key, value] of params) {
    if (key === 'or') { out = out.filter((r) => logicTerm(r, `or${value}`)); continue }
    if (['select', 'order', 'limit', 'offset', 'and'].includes(key)) continue
    if (value === 'is.null') out = out.filter((r) => r[key] === null || r[key] === undefined)
    else if (value.startsWith('eq.')) out = out.filter((r) => String(r[key]) === value.slice(3))
    else if (value.startsWith('in.(')) {
      const set = value.slice(4, -1).split(',').map((v) => v.replace(/^"|"$/g, ''))
      out = out.filter((r) => set.includes(String(r[key])))
    }
  }
  return out
}

const requests = []
let insertCounter = 100
/** Serve erp_preferences (stock adjustment reasons step only). */
let SERVE_PREFERENCES = false
// GRN actual purchase cost (migration 20261202090000): GRN_COST_COLUMNS = the support check finds the column;
// GRN_COST_CONFIRMED = the posting result carries actual_cost_supported.
let GRN_COST_COLUMNS = true
let GRN_COST_CONFIRMED = true
// Opening stock import adding to existing records (migration 20261206090000): off = an older database (the
// matches lookup is unknown); SMOKE_SOD = the inventory policy's segregation of duties.
let OPENING_ADDITIVE = false
let SMOKE_SOD = true
/** Extra rows in the stock register (set by the product image step only). */
let STOCK_POSITION_EXTRA = 0

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Range',
    'Content-Type': 'application/json',
    ...headers,
  })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

const api = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    })
    return res.end()
  }
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const url = new URL(req.url, `http://localhost:${API_PORT}`)
    // Storage uploads are multipart (files), not JSON.
    const body = raw && !(req.headers['content-type'] ?? '').startsWith('multipart/') ? JSON.parse(raw) : null
    const single = (req.headers.accept ?? '').includes('vnd.pgrst.object')
    // Product Master list / detail / export read the view product_master_list (migration 20261128090000); logged under the
    // products path so the list assertions apply to both, with the relation kept for the checks that need it.
    const viaView = url.pathname === '/rest/v1/product_master_list'
    requests.push({ method: req.method, path: viaView ? '/rest/v1/products' : url.pathname, query: url.search, body, ...(viaView ? { relation: 'product_master_list' } : {}) })

    if (url.pathname === '/auth/v1/token') {
      const user = USERS[body?.email]
      if (!user || body.password !== (passwords[body?.email] ?? 'correct-horse')) {
        return send(res, 400, { code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials' })
      }
      currentUser = { email: body.email, ...user }
      return send(res, 200, {
        access_token: fakeJwt(user.id), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: 'refresh-' + user.id,
        user: { id: user.id, aud: 'authenticated', role: 'authenticated', email: body.email, app_metadata: {}, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' },
      })
    }
    // Password reset: Supabase answers the same for unknown addresses; one code per minute per account.
    if (url.pathname === '/auth/v1/recover' && req.method === 'POST') {
      if (body?.email === RESET_EMAIL) {
        const wait = Math.ceil((recovery.lastSent + 60_000 - Date.now()) / 1000)
        if (wait > 0) return send(res, 429, { code: 'over_email_send_rate_limit', error_code: 'over_email_send_rate_limit', msg: `For security purposes, you can only request this after ${wait} seconds.` })
        recovery.lastSent = Date.now()
        recovery.code = RECOVERY_CODES[recovery.sends++ % RECOVERY_CODES.length]
        recovery.expired = false
      }
      return send(res, 200, {})
    }
    if (url.pathname === '/auth/v1/verify' && req.method === 'POST' && body?.type === 'recovery' && body?.email) {
      // Wrong, used, replaced and expired codes all get otp_expired, as in Supabase.
      if (body.email !== RESET_EMAIL || !recovery.code || body.token !== recovery.code || recovery.expired) {
        return send(res, 403, { code: 'otp_expired', error_code: 'otp_expired', msg: 'Token has expired or is invalid' })
      }
      recovery.code = null
      const user = USERS[RESET_EMAIL]
      currentUser = { email: RESET_EMAIL, ...user, recovering: true }
      return send(res, 200, {
        access_token: fakeJwt(user.id), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh-' + user.id,
        user: { id: user.id, aud: 'authenticated', role: 'authenticated', email: RESET_EMAIL, app_metadata: {}, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' },
      })
    }
    // Invitation links (token_hash) verified by the browser with verifyOtp.
    if (url.pathname === '/auth/v1/verify' && req.method === 'POST') {
      const email = INVITE_LINKS[body?.token_hash]
      if (!email || body?.type !== 'invite') return send(res, 403, { code: 'otp_expired', error_code: 'otp_expired', msg: 'Email link is invalid or has expired' })
      delete INVITE_LINKS[body.token_hash]
      const user = USERS[email]
      currentUser = { email, ...user }
      return send(res, 200, {
        access_token: fakeJwt(user.id), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh-' + user.id,
        user: { id: user.id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' },
      })
    }
    if (url.pathname === '/functions/v1/invite-user') {
      if (!currentUser || !has('users.manage')) return send(res, 403, { ok: false, code: 'FORBIDDEN', error: 'You do not have permission to manage users.' })
      const action = body?.action
      if (action === 'invite') {
        if (String(body.email).startsWith('offline')) return req.socket.destroy()
        if (!/^[0-9a-f-]{36}$/.test(body.idempotency_key ?? '')) return send(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'A request id (idempotency key) is required.' })
        const roles = ROLE_CATALOG.filter((r) => body.role_ids.includes(r.id))
        if (roles.some((r) => r.is_admin) && !currentUser.roles.includes('SUPER_ADMIN')) {
          return send(res, 403, { ok: false, code: 'FORBIDDEN', error: 'Only a Super Admin can assign administrative roles (Administrator).' })
        }
        if (invitationRows.some((r) => r.email === body.email && r.status === 'PENDING')) {
          return send(res, 409, { ok: false, code: 'DUPLICATE', error: `A pending invitation for ${body.email} already exists. Resend it instead of inviting again.` })
        }
        if (String(body.email).startsWith('fail')) {
          invitationRows.unshift(inviteRow({ email: body.email, full_name: body.full_name, status: 'FAILED', email_status: 'FAILED', email_error: 'Supabase Auth refused the e-mail (HTTP 500): e-mail provider error.' }))
          return send(res, 502, { ok: false, code: 'EMAIL_FAILED', error: 'The invitation e-mail could not be sent. The invitation was recorded as failed; check the e-mail settings and use Resend.' })
        }
        const row = inviteRow({ email: body.email, full_name: body.full_name, invited_at: NOW, expires_at: '2026-12-31T09:00:00Z', designation: body.details?.designation ?? null,
          employee_id: body.details?.employee_id ?? null, roles: roles.map((r) => ({ id: r.id, code: r.code, name: r.name })) })
        invitationRows.unshift(row)
        return send(res, 200, { ok: true, duplicate: false, status: 'PENDING', email_status: 'SENT', delivery: 'AUTH_INVITE', invitation_id: row.id, email: row.email,
          roles: roles.map((r) => r.name), expires_at: row.expires_at })
      }
      const row = invitationRows.find((r) => r.id === body?.invitation_id)
      if (!row) return send(res, 400, { ok: false, code: 'VALIDATION', error: 'Invitation not found.' })
      if (action === 'resend') {
        Object.assign(row, { status: 'PENDING', email_status: 'SENT', email_error: null, send_count: row.send_count + 1, expires_at: '2026-12-31T09:00:00Z' })
        return send(res, 200, { ok: true, resent: true, status: 'PENDING', email_status: 'SENT', invitation_id: row.id, email: row.email, roles: [], expires_at: row.expires_at })
      }
      if (action === 'revoke') {
        if ((body.reason ?? '').length < 3) return send(res, 400, { ok: false, code: 'VALIDATION', error: 'Give a reason for revoking (3 to 500 characters).' })
        Object.assign(row, { status: 'REVOKED', revoked_at: NOW, revoked_by: 'Smoke Tester', revoke_reason: body.reason })
        return send(res, 200, { ok: true, invitation_id: row.id, status: 'REVOKED', auth_user_deleted: true })
      }
      return send(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'Unknown action.' })
    }
    if (url.pathname === '/auth/v1/logout') return send(res, 204)
    if (url.pathname === '/auth/v1/user' && req.method === 'PUT' && currentUser?.recovering && body?.password) passwords[currentUser.email] = body.password
    if (url.pathname === '/auth/v1/user' && currentUser) {
      return send(res, 200, { id: currentUser.id, aud: 'authenticated', role: 'authenticated', email: currentUser.email, app_metadata: {}, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' })
    }
    if (url.pathname.startsWith('/storage/v1/object/list/')) return send(res, 200, [])
    // Signed links of uploaded product images (one batch), and the image they point to.
    if (req.method === 'POST' && /^\/storage\/v1\/object\/sign\/[^/]+$/.test(url.pathname)) {
      const bucket = url.pathname.split('/').pop()
      return send(res, 200, (body?.paths ?? []).map((p) => ({ path: p, error: null, signedURL: `/object/sign/${bucket}/${p}?token=smoke` })))
    }
    if (req.method === 'POST' && /^\/storage\/v1\/object\/sign\/support-attachments\/.+$/.test(url.pathname)) {
      return send(res, 200, { signedURL: `${url.pathname.slice('/storage/v1'.length)}?token=smoke` })
    }
    // Email outbox upload (forward copies the original attachments; compose uploads picked files).
    if (req.method === 'POST' && /^\/storage\/v1\/object\/support-attachments\/.+$/.test(url.pathname)) {
      return send(res, 200, { Key: url.pathname.slice('/storage/v1/object/'.length), Id: 'smoke-upload' })
    }
    if (req.method === 'GET' && url.pathname.startsWith('/storage/v1/object/sign/') && url.pathname.endsWith('.csv')) {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Access-Control-Allow-Origin': '*' })
      return res.end('Item,Qty\nBasin,2\n')
    }
    if (req.method === 'GET' && url.pathname.startsWith('/storage/v1/object/sign/')) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' })
      return res.end(Buffer.from(SMOKE_PNG, 'base64'))
    }
    // Storage remove (force reset clean-up): product images may be deleted, stored documents may not.
    if (req.method === 'DELETE' && /^\/storage\/v1\/object\/[^/]+$/.test(url.pathname)) {
      const bucket = url.pathname.split('/').at(-1)
      return send(res, 200, bucket === 'product-images' ? (body?.prefixes ?? []).map((name) => ({ name, bucket_id: bucket })) : [])
    }

    if (url.pathname === '/functions/v1/reset-erp-data') {
      if (!currentUser?.permissions.includes('system.reset_data')) return send(res, 403, { code: 'FORBIDDEN', error: 'Only an active Super Admin can reset ERP data.' })
      if (body?.confirmation !== 'RESET ERP') return send(res, 400, { code: 'CONFIRMATION', error: 'Type RESET ERP to confirm.' })
      if (body?.password !== 'correct-horse') return send(res, 401, { code: 'WRONG_PASSWORD', error: 'The password is incorrect. Nothing was deleted.' })
      return send(res, 200, { status: 'COMPLETED', run_id: 'run1', request_id: body.request_id, replayed: false, deleted: { customers: 4, suppliers: 1, notifications: 2 },
        deleted_total: 7, preserved: {}, kept_suppliers: 1, blockers: [], verification: { allowlist_empty: true, schema_unchanged: true, actor_access_valid: true },
        post_check: { ok: true, remaining: {}, actor_access_valid: true } })
    }
    if (url.pathname === '/functions/v1/force-reset-erp-data') {
      if (!currentUser?.permissions.includes('system.reset_data')) return send(res, 403, { code: 'FORBIDDEN', error: 'Only an active Super Admin can reset ERP data.' })
      if (body?.confirmation !== 'DELETE ALL COMPANY DATA') return send(res, 400, { code: 'CONFIRMATION', error: 'Type DELETE ALL COMPANY DATA to confirm.' })
      if (body?.company_id !== COMPANY_ID || body?.company_code?.toUpperCase() !== 'TEST' || body?.backup_id !== forceBackup?.id) {
        return send(res, 403, { code: 'DENIED', status: 'DENIED', error: 'The company code does not match. Type TEST to confirm.' })
      }
      if (body?.password !== 'correct-horse') return send(res, 401, { code: 'WRONG_PASSWORD', error: 'The password is incorrect. Nothing was deleted.' })
      forceRuns.unshift({ id: 'run-force', mode: 'FORCE', status: 'COMPLETED', started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
        requested_by: currentUser.id, deleted_total: 51, deleted_counts: { inventory_transactions: 40, sales_invoices: 3, customers: 4, products: 4 }, blockers: [],
        error_message: null, backup_id: forceBackup.id, approval_id: 'appr1' })
      return send(res, 200, { status: 'COMPLETED', mode: 'FORCE', run_id: 'run-force', request_id: body.request_id, replayed: false,
        deleted: { inventory_transactions: 40, sales_invoices: 3, customers: 4, products: 4 }, deleted_total: 51, blockers: [],
        verification: { purge_tables_empty: true, other_companies_unchanged: true, schema_unchanged: true, actor_access_valid: true },
        post_check: { ok: true, remaining: {}, storage_remaining: 0, actor_access_valid: true, super_admins: 1 },
        storage_cleanup: { listed: 3, removed: 3, failed: 0, error: null } })
    }
    if (url.pathname === '/rest/v1/erp_reset_runs') {
      return has('system.reset_data') ? send(res, 200, forceRuns) : send(res, 200, [])
    }
    if (url.pathname === '/functions/v1/acefone-click-to-call') {
      if (!currentUser) return send(res, 401, { error: 'Sign in again.' })
      if (body?.action === 'status') return has('support.manage_integrations') ? send(res, 200, { configured: true, secrets: { api_token: true, support_api_key: false, webhook_secret: true } })
        : send(res, 403, { error: 'You are not allowed to manage integrations.' })
      if (body?.action === 'test') return send(res, 200, { ok: true, message: 'Acefone answered: 1 call record readable.' })
      if (body?.action === 'agents') { SOFT.agentsReads++; return has('support.manage_integrations') ? send(res, 200, { ok: true, matched: 1, message: '3 Acefone users read. 1 lines matched.' }) : send(res, 403, { error: 'requires support.manage_integrations' }) }
      if (body?.action === 'call') {
        if (!has('support.reply')) return send(res, 403, { error: 'You are not allowed to place calls.' })
        const same = PHONE_CALLS.find((c) => c.idem === body.idempotency_key)
        if (same) return send(res, 200, { call_id: same.id, status: same.status, duplicate: true })
        const id = `call${PHONE_CALLS.length + 1}`
        PHONE_CALLS.unshift({ id, idem: body.idempotency_key, direction: 'OUTBOUND', status: 'INITIATED', customer_id: body.customer_id ?? null, customer_name: 'Ravi Kumar', customer_number: body.number,
          caller_number: '0501234567', destination_number: body.number, agent_name: 'Smoke Agent', ticket_id: null, ticket_number: null, started_at: null, ended_at: null,
          ring_seconds: null, talk_seconds: null, disposition: null, has_recording: false, created_at: new Date().toISOString() })
        // The provider only accepted the request: the call stays Initiated until a webhook reports progress.
        return send(res, 200, { call_id: id, status: 'INITIATED', request_state: 'ACCEPTED' })
      }
      return send(res, 400, { error: 'Unknown action.' })
    }
    if (url.pathname === '/functions/v1/acefone-sync-cdr') return send(res, 200, { results: [{ ok: true, records: 0, message: 'No new call records.' }] })
    if (url.pathname === '/functions/v1/acefone-recording-sync') return send(res, 200, { results: [{ skipped: 'Recording retrieval is off.' }] })
    if (url.pathname === '/functions/v1/google-oauth-start') {
      if (!currentUser) return send(res, 401, { error: 'Sign in first.' })
      if (!has('support.manage_integrations')) return send(res, 403, { error: 'requires support.manage_integrations' })
      if (body?.action === 'status') return send(res, 200, { secrets: { client_id: true, client_secret: true, redirect_uri: true, encryption_key: true, app_url: true, push_token: true, push_oidc: false, cron_secret: true },
        problems: [], redirect_uri: 'http://127.0.0.1:54321/functions/v1/google-oauth-callback', webhook_url: 'http://127.0.0.1:54321/functions/v1/google-gmail-webhook?token=<GMAIL_PUSH_TOKEN>' })
      if (body?.action === 'start') {
        // The mock "Google" authorises immediately and the callback sends the browser back to the ERP.
        GMAIL.startCalls++
        GMAIL.connected = true
        return send(res, 200, { url: '/support/settings?tab=email&gmail=connected' })
      }
      if (body?.action === 'test') return send(res, 200, { ok: true, message: 'Connected: Gmail answered for support@alton.example.' })
      if (body?.action === 'disconnect') { GMAIL.connected = false; return send(res, 200, { ok: true, revoked: true }) }
      return send(res, 400, { error: 'Unknown action.' })
    }
    if (url.pathname === '/functions/v1/google-gmail-send' && body?.action === 'original') {
      if (!currentUser || !has('support.view')) return send(res, 403, { error: 'requires support.view' })
      GMAIL.originalCalls.push(body)
      if (body.format === 'raw') return send(res, 200, { raw: Buffer.from('Subject: Cracked basin\r\n\r\nThe basin arrived cracked.').toString('base64url'), size: 50 })
      return send(res, 200, { size: 2048, headers: [{ name: 'Received', value: 'from mail.customer.example by mx.google.com' },
        { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@customer.example; spf=pass smtp.mailfrom=ravi@customer.example; dmarc=pass (p=NONE)' },
        { name: 'DKIM-Signature', value: 'v=1; a=rsa-sha256; d=customer.example' }, { name: 'Message-ID', value: '<aaaa000001@customer.example>' }] })
    }
    if (url.pathname === '/functions/v1/google-gmail-send') {
      if (!currentUser || !has('support.reply')) return send(res, 403, { error: 'requires support.reply' })
      GMAIL.sendCalls.push(body)
      const state = GMAIL.sendOutcome
      return send(res, 200, { email_id: `out-${GMAIL.sendCalls.length}`, conversation_id: 'sc-mail', send_state: state,
        message: state === 'SENT' ? 'Sent: Gmail accepted the message.' : state === 'FAILED' ? 'Gmail refused the message: Invalid To header' : 'Gmail did not confirm the message. It shows as Pending until the next mailbox sync confirms it.' })
    }
    if (url.pathname === '/functions/v1/google-gmail-sync') {
      GMAIL.syncCalls.push(body ?? {})
      if (SYNC.status) {
        return send(res, 200, { results: [{ ok: true, busy: false, kind: 'FULL', stored: 12, duplicates: 0, confirmed: 0, failed: 0, remaining: 1338, more: true, continuing: true,
          message: body?.action === 'retry' ? 'Mailbox sync: 1 new email.' : 'Full re-sync: 12 new emails.' }] })
      }
      return send(res, 200, { results: [{ ok: true, kind: body?.action === 'replay' ? 'REPLAY' : 'HISTORY', stored: 0, duplicates: 1, confirmed: 0, failed: 0, remaining: 0,
        message: body?.action === 'replay' ? 'Mailbox history synchronised: 0 new, 1 already stored.' : 'Mailbox history synchronised: 1 new.' }] })
    }
    if (url.pathname === '/functions/v1/whatsapp-webhook-verify') {
      if (!has('support.manage_integrations')) return send(res, 403, { error: 'requires support.manage_integrations' })
      return send(res, 200, { secrets: { access_token: true, app_secret: true, verify_token: false, cron_secret: true },
        callback_url: 'http://127.0.0.1:54321/functions/v1/whatsapp-webhook?account=sca-wa', subscription: { checked: true, subscribed: true, message: 'The app is subscribed to this WhatsApp Business Account.' } })
    }
    if (url.pathname === '/functions/v1/whatsapp-sync-status') {
      if (!has('support.manage_integrations')) return send(res, 403, { error: 'requires support.manage_integrations' })
      return send(res, 200, { results: [{ account: 'sca-wa', test: { ok: true, message: 'Connected: Alton +91 1800 123 4567 on the Cloud API, quality GREEN.' },
        templates: { ok: true, message: '2 templates synchronised.' } }] })
    }
    if (url.pathname === '/functions/v1/whatsapp-send-message') {
      if (!has('support.reply')) return send(res, 403, { error: 'requires support.reply' })
      WA.sendCalls.push(body)
      if (!WA.windowOpen) return send(res, 400, { error: 'The 24-hour customer service window is closed. Only an approved template can be sent now.' })
      return send(res, 200, { id: `wout${WA.sendCalls.length}`, conversation_id: 'sc-wa', status: 'PENDING', message: 'Accepted by Meta. The status changes to Sent, Delivered or Read when Meta reports it.' })
    }
    if (url.pathname === '/functions/v1/whatsapp-send-template') {
      if (!has('support.reply')) return send(res, 403, { error: 'requires support.reply' })
      WA.templateCalls.push(body)
      return send(res, 200, { id: `wtpl${WA.templateCalls.length}`, conversation_id: 'sc-wa', status: 'PENDING', message: 'Accepted by Meta. The status changes to Sent, Delivered or Read when Meta reports it.' })
    }
    if (url.pathname === '/functions/v1/whatsapp-media-download') return send(res, 200, { results: [{ id: 'wm2', state: 'STORED' }] })
    if (url.pathname.startsWith('/functions/v1/amazon-')) {
      return send(res, 412, { error: 'Selling Partner API credentials are not configured.', variables: [{ name: 'AMAZON_SPAPI_LWA_CLIENT_ID', set: false }, { name: 'AMAZON_COMPANY_CODE', set: false }] })
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = url.pathname.slice('/rest/v1/rpc/'.length)
      if (failNext.delete(fn)) return send(res, 500, { code: 'XX000', message: 'simulated server failure (test only)' })
      switch (fn) {
        case 'analytics_context':
          return send(res, 200, analyticsContext())
        case 'analytics_executive':
          return send(res, 200, analyticsExecutive(body))
        case 'analytics_sales':
          return has('sales_orders.read') ? send(res, 200, ANALYTICS_SALES(body)) : send(res, 403, { code: '42501', message: 'You are not allowed to perform this action (requires sales_orders.read).' })
        case 'analytics_inventory':
          return send(res, 200, ANALYTICS_INVENTORY(body))
        case 'analytics_production':
          return send(res, 200, ANALYTICS_PRODUCTION(body))
        case 'analytics_fulfilment':
          return send(res, 200, ANALYTICS_FULFILMENT(body))
        case 'analytics_shortages':
          return send(res, 200, ANALYTICS_SHORTAGES(body))
        case 'analytics_finance':
          return has('billing_reports.read') ? send(res, 200, ANALYTICS_FINANCE(body)) : send(res, 403, { code: '42501', message: 'You are not allowed to perform this action (requires billing_reports.read).' })
        case 'analytics_alerts':
          return send(res, 200, ANALYTICS_ALERTS())
        case 'analytics_data_quality':
          return has('audit_logs.read') ? send(res, 200, ANALYTICS_DQ()) : send(res, 403, { code: '42501', message: 'You are not allowed to perform this action (requires audit_logs.read).' })
        case 'erp_reset_preview':
          return has('system.reset_data') ? send(res, 200, RESET_PREVIEW())
            : send(res, 403, { code: '42501', message: 'Only a Super Admin with the system.reset_data permission can reset ERP data.' })
        // Department data management (20261119090000)
        case 'department_data_overview':
          if (!currentUser?.permissions.includes('system.reset_data')) return send(res, 403, { code: '42501', message: 'Only an active Super Admin with the system.reset_data permission can manage department data.' })
          return send(res, 200, { generated_at: NOW, backup: deptBackup, last_runs: deptRuns, departments: deptOverview() })
        case 'department_data_preview':
        case 'department_data_preview_records': {
          const p = deptPreview(body.p_department, body.p_operation, body.p_categories, body.p_keys ?? null)
          return send(res, 200, { ...p, confirmation_phrase: `${body.p_operation} ${body.p_department}`, requires_backup: body.p_operation === 'DELETE',
            requires_password: body.p_operation === 'DELETE', backup: body.p_operation === 'DELETE' ? deptBackup : null })
        }
        case 'department_data_execute':
        case 'department_data_execute_records': {
          if (body.p_confirmation !== `${body.p_operation} ${body.p_department}`) return send(res, 200, { status: 'DENIED', error: `Type ${body.p_operation} ${body.p_department} to confirm.` })
          if (body.p_operation === 'DELETE' && (!deptBackup || body.p_backup_id !== deptBackup.id)) return send(res, 200, { status: 'DENIED', error: 'Record a backup taken in the last 24 hours first (each backup record can be used once).' })
          const p = deptPreview(body.p_department, body.p_operation, body.p_categories, body.p_keys ?? null)
          const stale = body.p_plan_hash !== p.plan_hash || body.p_categories.includes('sales.unposted_orders')
          if (!stale && p.records) for (const r of p.records) pdDeleted.add(r.key)
          const run = { id: `run-${deptRuns.length + 1}`, department: body.p_department, operation: body.p_operation, categories: body.p_categories,
            status: stale ? 'BLOCKED' : 'COMPLETED', started_at: NOW, finished_at: NOW, deleted_counts: stale ? {} : p.tables, deleted_total: stale ? 0 : p.total,
            error_message: stale ? 'The data changed after the preview. Nothing was changed; preview again.' : null, requested_by: 'Owner Tester', replayed: false }
          deptRuns.unshift(run)
          if (!stale && body.p_operation === 'DELETE') deptBackup = null
          return send(res, 200, run)
        }
        case 'department_data_history':
          return send(res, 200, deptRuns)
        case 'erp_force_reset_record_backup':
          deptBackup = { id: 'bk-' + (deptRuns.length + 1), backup_method: body.p_backup_method, backup_reference: body.p_backup_reference, backup_taken_at: body.p_backup_taken_at,
            recorded_by: currentUser.id, valid_until: '2026-12-31T00:00:00Z' }
          return send(res, 200, deptBackup)
        case 'erp_force_reset_preview':
          if (!has('system.reset_data')) return send(res, 403, { code: '42501', message: 'Only a Super Admin with the system.reset_data permission can reset ERP data.' })
          return body?.p_company_id === COMPANY_ID ? send(res, 200, FORCE_PREVIEW())
            : send(res, 403, { code: '42501', message: 'You can only preview a force reset of the company your account belongs to.' })
        case 'erp_force_reset_now':
          if (!has('system.reset_data')) return send(res, 200, { status: 'DENIED', error: 'Only an active Super Admin with the system.reset_data permission can reset ERP data.' })
          if (body?.p_company_id !== COMPANY_ID) return send(res, 200, { status: 'DENIED', error: 'You can only reset the company your account belongs to.' })
          forceRuns.unshift({ id: 'run-force', mode: 'FORCE', status: 'COMPLETED', started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
            requested_by: currentUser.id, deleted_total: 51, deleted_counts: { inventory_transactions: 40, sales_invoices: 3, customers: 4, products: 4 }, blockers: [],
            error_message: null, backup_id: null, approval_id: null })
          return send(res, 200, { status: 'COMPLETED', mode: 'FORCE', run_id: 'run-force', request_id: body.p_request_id, replayed: false, error: null,
            deleted: { inventory_transactions: 40, sales_invoices: 3, customers: 4, products: 4 }, deleted_total: 51, blockers: [],
            verification: { purge_tables_empty: true, other_companies_unchanged: true, schema_unchanged: true, actor_access_valid: true },
            storage_files: [{ bucket: 'product-images', name: `${COMPANY_ID}/p1/a.jpg` }, { bucket: 'product-images', name: `${COMPANY_ID}/p2/b.jpg` },
              { bucket: 'documents', name: `${COMPANY_ID}/d1/v1.pdf` }] })
        // Master versioning (20261118090000)
        case 'product_version_history':
          return send(res, 200, { product: { id: body.p_product_id, sku: 'MOCK-WC-1', product_name: 'Mock Closet 1 Premium', product_type: 'FINISHED_GOOD' }, versions: [
            { id: 'pv2', version_no: 2, effective_from: NOW, effective_to: null, is_current: true, is_legacy: false, source: 'UPDATED', change_reason: 'New glaze from the supplier',
              changes: { product_name: { from: 'Mock Closet 1', to: 'Mock Closet 1 Premium' }, standard_cost: { from: 1000, to: 1150 } }, created_by: 'Smoke Tester', created_at: NOW,
              values: { sku: 'MOCK-WC-1', product_name: 'Mock Closet 1 Premium', base_unit: 'PCS', hsn_code: '6910', standard_cost: 1150, gst_rate: 18 } },
            { id: 'pv1', version_no: 1, effective_from: '2026-10-01T00:00:00Z', effective_to: NOW, is_current: false, is_legacy: true, source: 'LEGACY_BASELINE',
              change_reason: 'Legacy baseline: the values when version control was introduced. Earlier changes were not recorded.', changes: null, created_by: null,
              created_at: '2026-10-01T00:00:00Z', values: { sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', base_unit: 'PCS', hsn_code: '6910', standard_cost: 1000, gst_rate: 18 } }] })
        case 'bom_version_history': {
          const it = (id, sku, q, v, c = 10) => ({ component_product_id: id, line_no: 1, sku, product_name: sku, component_version: v, quantity: q, unit: 'PCS', wastage_percentage: 0, notes: null,
            standard_cost: c, line_cost: q * c })
          return send(res, 200, { product: { id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1' }, versions: [
            { id: 'bom2', bom_code: 'BOM-000001', version: 2, status: 'APPROVED', lifecycle: 'ACTIVE', effective_from: TODAY, effective_to: null, output_quantity: 1, output_unit: 'PCS',
              notes: null, change_reason: 'Three-bowl design', process_instructions: 'Torque 5 Nm', created_by: 'Smoke Tester', created_at: NOW, approved_by: 'Smoke Tester', approved_at: NOW,
              modified_at: NOW, superseded_by: null, items: [it('pa', 'MOCK-A1', 3, 'v2', 12), it('pb', 'MOCK-B1', 2, 'v1'), it('pn', 'MOCK-PLUG', 1, 'v1', 3)] },
            { id: 'bom1', bom_code: 'BOM-000001', version: 1, status: 'ARCHIVED', lifecycle: 'SUPERSEDED', effective_from: '2026-10-01', effective_to: '2026-11-01', output_quantity: 1,
              output_unit: 'PCS', notes: null, change_reason: 'First release', process_instructions: null, created_by: 'Smoke Tester', created_at: NOW, approved_by: 'Smoke Tester',
              approved_at: NOW, modified_at: NOW, superseded_by: 2, items: [it('pa', 'MOCK-A1', 1, 'v1'), it('pb', 'MOCK-B1', 2, 'v1'), it('po', 'MOCK-OLD', 1, 'Legacy / Unversioned', 2)] }] })
        }
        case 'production_bom_save_and_activate':
          if (!has('production_bom.approve')) return send(res, 403, { code: '42501', message: 'You are not allowed to perform this action (requires production_bom.approve).' })
          if (body.p_bom_id === 'bom1' && !(body.p_change_reason ?? '').trim()) return send(res, 400, { code: 'P0001', message: 'Enter the reason for this change: it is kept with the new BOM version.' })
          return send(res, 200, { bom_id: 'bom2', bom_code: 'BOM-000001', version: 2, new_version: body.p_bom_id === 'bom1', activated: true, status: 'APPROVED',
            superseded_versions: ['v1'], closed_versions: [] })
        case 'draft_version_check': {
          const items = body.p_kind === 'PRODUCTION_ORDER' ? [
            { product_id: 'p1', sku: 'MOCK-WC-1', field: 'BOM version', draft_value: 'BOM-000001 v1', current_value: 'BOM-000001 v2', refreshable: true },
            { product_id: 'pa', sku: 'MOCK-CLAY', field: 'Component version', draft_value: 'v1 · Mock ceramic body · cost 10', current_value: 'v2 · Mock ceramic body · cost 12', refreshable: true }]
            : body.p_kind === 'PURCHASE_ORDER' && !draftRefreshed.has(body.p_id) ? [
              { product_id: 'p1', sku: 'MOCK-WC-1', field: 'Description', draft_value: 'Mock Closet 1', current_value: 'Mock Closet 1 Premium', refreshable: true },
              { product_id: 'p1', sku: 'MOCK-WC-1', field: 'GST rate', draft_value: 12, current_value: 18, refreshable: false }] : []
          return send(res, 200, { kind: body.p_kind, id: body.p_id, status: 'DRAFT', stale: items.length > 0, items })
        }
        case 'draft_refresh_versions':
          draftRefreshed.add(body.p_id)
          return send(res, 200, { kind: body.p_kind, id: body.p_id, refreshed_lines: 1 })
        case 'bom_version_details_save':
          return send(res, 200, { bom_id: body.p_bom_id, change_reason: body.p_change_reason, process_instructions: body.p_process_instructions })
        // Persistent form drafts (20261117090000): same versioning rules as the database.
        case 'erp_form_draft_get': {
          const row = formDrafts.get(draftKeyOf(body))
          return send(res, 200, row ? draftJson(row) : null)
        }
        case 'erp_form_draft_save': {
          if (draftFailures > 0) { draftFailures--; return send(res, 500, { code: 'XX000', message: 'simulated draft save failure (test only)' }) }
          const k = draftKeyOf(body)
          const row = formDrafts.get(k)
          const expected = body.p_expected_version ?? 0
          if (row && row.version !== expected && !(row.status !== 'draft' && expected === 0)) return send(res, 200, { status: 'CONFLICT', draft: draftJson(row) })
          const next = { id: row?.id ?? `draft-${formDrafts.size + 1}`, version: (row?.version ?? 0) + 1, status: 'draft', data: body.p_data,
            base_version: body.p_base_version ?? null, last_saved_at: new Date().toISOString(), form_key: body.p_form_key }
          formDrafts.set(k, next)
          return send(res, 200, { status: 'SAVED', draft: draftJson(next) })
        }
        case 'erp_form_draft_close': {
          const k = draftKeyOf(body)
          const row = formDrafts.get(k)
          if (!row || row.status !== 'draft') return send(res, 200, { status: body.p_status, version: 0 })
          const closed = { ...row, status: body.p_status, data: {}, version: row.version + 1 }
          formDrafts.set(k, closed)
          return send(res, 200, draftJson(closed))
        }
        case 'invite_role_catalog': {
          if (!has('users.manage')) return send(res, 403, { code: '42501', message: 'You are not allowed to perform this action (requires users.manage).' })
          const isSuper = currentUser.roles.includes('SUPER_ADMIN')
          return send(res, 200, { is_super_admin: isSuper, roles: ROLE_CATALOG.map((r) => ({ ...r, assignable: isSuper || !r.is_admin })) })
        }
        case 'user_invitations_list':
          return has('users.manage') ? send(res, 200, invitationRows) : send(res, 403, { code: '42501', message: 'not allowed' })
        case 'my_invitation': {
          if (currentUser.email === 'new.hire@test.invalid') {
            return send(res, 200, { invitation_id: 'inv-new', company_name: 'Test Co', full_name: 'New Hire', email: currentUser.email, roles: ['Sales Executive'],
              status: currentUser.active === false ? 'PENDING' : 'ACCEPTED', expires_at: '2026-12-31T09:00:00Z', support_email: 'support@test.invalid' })
          }
          if (currentUser.email === 'revoked.hire@test.invalid') {
            return send(res, 200, { invitation_id: 'inv-rev', company_name: 'Test Co', full_name: 'Revoked Hire', email: currentUser.email, roles: ['Sales Executive'],
              status: 'REVOKED', expires_at: '2026-12-31T09:00:00Z', support_email: 'support@test.invalid' })
          }
          return send(res, 200, null)
        }
        case 'user_invitation_accept':
          if (currentUser.email !== 'new.hire@test.invalid') return send(res, 400, { code: 'P0001', message: 'This invitation was revoked. Contact your administrator.' })
          currentUser.active = true
          USERS['new.hire@test.invalid'].active = true
          return send(res, 200, { invitation_id: 'inv-new', status: 'ACCEPTED', company_id: COMPANY_ID, roles: ['Sales Executive'] })
        case 'get_my_access':
          if (!currentUser) return send(res, 401, { code: 'PGRST301', message: 'JWT expired' })
          return send(res, 200, {
            profile: { id: currentUser.id, email: currentUser.email, full_name: 'Smoke Tester', company_id: COMPANY_ID, is_active: currentUser.active !== false },
            company: { id: COMPANY_ID, legal_name: 'Test Co', display_name: 'Test Co', company_code: 'TEST', currency_code: 'INR', timezone: 'Asia/Kolkata', is_active: true },
            roles: currentUser.roles,
            permissions: currentUser.permissions,
          })
        case 'product_duplicate_hints': {
          const key = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
          const out = []
          for (const id of body.p_ids ?? []) {
            const p = products.find((x) => x.id === id)
            const same = p ? products.filter((o) => o.id !== p.id && key(o.product_name) === key(p.product_name)) : []
            if (same.length) out.push({ product_id: id, kind: 'name', matches: same.length, match_skus: same.map((o) => o.sku).sort().slice(0, 5) })
          }
          return send(res, 200, out)
        }
        case 'product_bulk_delete_preview':
        case 'product_bulk_delete': {
          if (!currentUser?.roles.includes('SUPER_ADMIN')) return send(res, 403, { code: '42501', message: 'Only a Super Admin can delete products.' })
          const USED = { p1: [['Sales invoices', 'sales_invoice_lines', 2]], p2: [['Sales orders', 'sales_order_lines', 1]],
            p3: [['Stock ledger entries', 'inventory_transactions', 3], ['Stock balances', 'inventory_balances', 1]], p4: [['BOM components', 'bom_items', 1]] }
          const own = (body.p_ids ?? []).map((id) => products.find((p) => p.id === id && p.company_id === COMPANY_ID)).filter(Boolean)
          const describe = (p) => ({ id: p.id, sku: p.sku, product_name: p.product_name, category: categories.find((c) => c.id === p.category_id)?.name ?? null,
            standard_manufacturing_cost: p.standard_manufacturing_cost ?? null, mrp: p.mrp ?? null, hsn_code: p.hsn_code, gst_rate: p.gst_rate, status: p.status,
            archived: Boolean(p.archived_at), deletable: !USED[p.id], has_stock: p.id === 'p3', can_archive: Boolean(USED[p.id]) && p.id !== 'p3' && !p.archived_at,
            blockers: (USED[p.id] ?? []).map(([label, table, count]) => ({ label, table, count })) })
          const rows = own.map(describe)
          const notFound = (body.p_ids ?? []).filter((id) => !own.some((p) => p.id === id))
          if (fn === 'product_bulk_delete_preview') {
            return send(res, 200, { products: rows, not_found: notFound, deletable: rows.filter((r) => r.deletable).length, blocked: rows.filter((r) => !r.deletable).length })
          }
          if (body.p_confirmation !== 'DELETE PRODUCTS') return send(res, 200, { status: 'DENIED', error: 'Type DELETE PRODUCTS to confirm.' })
          for (const r of rows) if (r.deletable) products.splice(products.findIndex((p) => p.id === r.id), 1)
          return send(res, 200, { status: 'COMPLETED', error: null, request_id: body.p_request_id, not_found: notFound, failed: [],
            deleted: rows.filter((r) => r.deletable).map((r) => ({ id: r.id, sku: r.sku, product_name: r.product_name })),
            blocked: rows.filter((r) => !r.deletable).map((r) => ({ ...r, archived_now: false, archive_error: null })) })
        }
        case 'product_kpis': {
          const active = products.filter((p) => p.status === 'ACTIVE')
          return send(res, 200, {
            active: active.length, in_house: active.filter((p) => p.default_source_type === 'IN_HOUSE').length,
            outsourced: active.filter((p) => p.default_source_type === 'OUTSOURCED').length,
            hybrid: active.filter((p) => p.default_source_type === 'HYBRID').length,
            inactive: products.filter((p) => p.status === 'INACTIVE').length, archived: 0, total: products.length,
            finished_goods: active.filter((p) => p.product_type === 'FINISHED_GOOD').length, raw_materials: active.filter((p) => p.product_type === 'RAW_MATERIAL').length,
            components: active.filter((p) => p.product_type === 'COMPONENT').length,
            // Same rule as product_kpis.incomplete.
            incomplete: active.filter((p) => !p.hsn_code || p.gst_rate === null || !p.category_id
              || (p.product_type === 'FINISHED_GOOD' ? p.selling_price === null : p.standard_cost === null && (p.standard_manufacturing_cost ?? null) === null)).length,
          })
        }
        case 'product_category_counts':
          return send(res, 200, [{ category_id: 'c2', total_products: products.length, active_products: 1 }])
        case 'check_product_identifiers':
          return send(res, 200, products
            .filter((p) => (body.p_skus ?? []).includes(p.sku.toLowerCase()))
            .map((p) => ({ kind: 'sku', value: p.sku, product_id: p.id, sku: p.sku })))
        case 'user_display_names':
          return send(res, 200, (body.p_user_ids ?? []).map((id) => ({ user_id: id, display_name: id === VIEWER_ID ? 'Viewer Tester' : 'Smoke Tester' })))
        case 'inventory_overview':
          return send(res, 200, {
            active_products: 1, products_with_stock: 1, never_stocked: 0, out_of_stock: 0, fully_reserved: 0, low_stock: 0, healthy: 1, no_threshold: 0,
            units: [{ unit: 'PCS', on_hand: 140, reserved: 10, available: 130, in_house: 100, outsourced: 40, unknown: 0 }],
            by_category: CATEGORY_ROWS ?? [{ category: 'Water Closets / Toilets', unit: 'PCS', on_hand: 140 }],
            by_warehouse: [{ warehouse_code: 'MAIN', warehouse_name: 'Mock main store', unit: 'PCS', on_hand: 140 }],
            first_transaction_at: NOW, last_transaction_at: NOW, warehouses: 1, pending_opening: 1, pending_adjustments: 1, pending_counts: 0,
            timezone: 'Asia/Kolkata', as_of: NOW,
          })
        case 'inventory_movement_trend':
          return send(res, 200, [{ bucket: TODAY, unit: 'PCS', quantity_in: 140, quantity_out: 0, transactions: 2 }])
        case 'inventory_policy_info':
          return send(res, 200, { segregation_of_duties: SMOKE_SOD, expiry_warning_days: 30, timezone: 'Asia/Kolkata', today: TODAY, negative_stock_allowed: false })
        case 'inventory_find_product_by_code': {
          const code = String(body.p_code ?? '').trim().toLowerCase()
          return send(res, 200, products.filter((p) => p.barcode === code || p.sku.toLowerCase() === code).map((p) => ({
            product_id: p.id, sku: p.sku, product_name: p.product_name, base_unit: p.base_unit, track_batches: p.track_batches, track_expiry: p.track_expiry,
            product_status: p.status, matched_on: p.barcode === code ? 'BARCODE' : 'SKU' })))
        }
        case 'inventory_post_receipt':
          return send(res, 200, { transaction_id: 't9', transaction_number: 'TXN-000009' })
        // The older functions are not callable by users (migration 20261130090000).
        case 'inventory_submit_opening_stock':
        case 'inventory_post_opening_stock':
          return send(res, 403, { code: '42501', message: `permission denied for function ${fn}` })
        // Existing opening stock: MOCK-WC-1 at MAIN/BIN-1, OS-000003, 100 PCS at ₹850.
        case 'opening_stock_import_matches':
          if (!OPENING_ADDITIVE) return send(res, 404, { code: 'PGRST202', message: 'Could not find the function public.opening_stock_import_matches' })
          return send(res, 200, (body.p_product_ids ?? []).includes('p1') ? [{ opening_line_id: 'ol3', document_number: 'OS-000003', status: 'POSTED', product_id: 'p1', location_id: 'l2',
            batch_number: null, source_type: 'IN_HOUSE', quantity: 100, added_quantity: 0, unit_cost: 850, lot_id: 'lot-IN_HOUSE', lot_cost: 850, on_hand: 100 }] : [])
        case 'inventory_import_opening_stock': {
          let running = 100
          const lines = body.p_lines ?? []
          const adds = lines.filter((l) => l.product_id === 'p1' && l.location_id === 'l2')
          const fresh = lines.length - adds.length
          return send(res, 200, { ok: true, new_lines: fresh, ...(fresh ? { opening_batch_id: 'ob10', document_number: 'OS-000010', line_count: fresh } : {}), status: 'POSTED', kept: [],
            additions: adds.map((l, i) => ({ line_no: l.line_no, document_number: 'OS-000003', opening_line_id: 'ol3', previous_quantity: running, added_quantity: l.quantity,
              new_quantity: (running += l.quantity), unit_cost: 850, cost_source: 'EXISTING_LOT_COST', transaction_number: `TXN-00012${i}` })) })
        }
        case 'inventory_submit_opening_stock_at_cost':
        case 'inventory_post_opening_stock_at_cost':
          return send(res, 200, { ok: true, opening_batch_id: 'ob9', document_number: 'OS-000009', line_count: body.p_lines.length })
        // Product Master Cost for opening stock (migration 20261129090000): MOCK-WC-1 ₹850 (second-most-recent GRN),
        // MOCK-CLAY ₹42.50 (standard cost), MOCK-GLZ none.
        case 'opening_stock_product_costs': {
          const OPENING_COSTS = { p1: [850, 'PURCHASE'], p2: [1200, 'STANDARD'], p3: [42.5, 'STANDARD'] }
          return send(res, 200, { override_allowed: Boolean(ERP_SETTINGS.settings['inventory.opening_cost_override']) && Boolean(currentUser?.permissions.includes('settings.manage')), costs: (body.p_product_ids ?? []).map((id) => products.find((p) => p.id === id)).filter(Boolean).map((p) => ({
            product_id: p.id, sku: p.sku, product_name: p.product_name, cost: OPENING_COSTS[p.id]?.[0] ?? null, source: OPENING_COSTS[p.id]?.[1] ?? null,
            valid: Boolean(OPENING_COSTS[p.id]) })) })
        }
        case 'inventory_create_adjustment':
        case 'inventory_create_adjustment_v2':
          return send(res, 200, { adjustment_id: 'a9', adjustment_number: 'ADJ-000009', status: body.p_submit ? 'PENDING_APPROVAL' : 'DRAFT', reason_label: body.p_reason_label ?? null })
        case 'inventory_post_adjustment_v2':
          return send(res, 200, { adjustment_id: 'a9', adjustment_number: 'ADJ-000009', status: 'POSTED', transactions: ['TXN-000099'] })
        case 'inventory_refresh_alerts':
          return send(res, 200, { opened: 0, resolved: 0, active: 1 })
        case 'inventory_expire_reservations':
          return send(res, 200, 0)
        case 'inventory_stock_as_of':
          return send(res, 200, [{ product_id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', category_name: null, warehouse_code: 'MAIN', warehouse_name: 'Mock', location_code: 'GENERAL', batch_number: null, source_type: 'IN_HOUSE', quantity: 100 }])
        case 'inventory_valuation':
          return send(res, 200, [
            { product_id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', category_name: null, source_type: 'IN_HOUSE', warehouse_code: 'MAIN', location_code: 'GENERAL', batch_number: null, on_hand: 100, unit_cost: 450, value: 45000 },
            { product_id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', category_name: null, source_type: 'OUTSOURCED', warehouse_code: 'MAIN', location_code: 'GENERAL', batch_number: null, on_hand: 40, unit_cost: null, value: null },
          ])
        case 'production_overview':
          return send(res, 200, PRODUCTION_OVERVIEW)
        case 'whole_unit_quantity_audit':
          return send(res, 200, {
            generated_at: NOW, whole_units: ['PCS', 'NOS', 'SET', 'PAIR'], total: 3, truncated: false,
            summary: [{ category: 'STOCK_BALANCE', classification: 'INVALID_PHYSICAL', count: 1 }],
            findings: [
              { category: 'STOCK_BALANCE', classification: 'INVALID_PHYSICAL', reference: 'MOCK-A1 @ MAIN/GENERAL', record_id: 'b1', link: '/inventory/stock/p1', sku: 'MOCK-A1', unit: 'PCS', field: 'on_hand', value: 312.141, detail: 'On hand 312.141, reserved 0, available 312.141 PCS (source OUTSOURCED)' },
              { category: 'LEDGER_ENTRY', classification: 'INVALID_PHYSICAL', reference: 'TXN-000042', record_id: 't42', link: '/inventory/stock/p1', sku: 'MOCK-A1', unit: 'PCS', field: 'quantity', value: 0.286, detail: 'PRODUCTION_ISSUE -0.286 PCS on 2026-10-20 for PRODUCTION_ORDER PRD-000001' },
              { category: 'BOM_LINE', classification: 'THEORETICAL_RATIO', reference: 'BOM-000001 v3 line 1', record_id: 'bom1', link: '/production/boms/bom1', sku: 'MOCK-A1', unit: 'PCS', field: 'quantity_required', value: 2, detail: '2 PCS per 70 PCS of ALD = 0.028571 per finished unit (BOM approved)' },
            ],
          })
        case 'production_bom_requirements':
          return send(res, 200, [
            requirementLine(1, 'p3', 'MOCK-CLAY', 'Mock ceramic body', Number(body.p_quantity) * 2.5, 75),
            requirementLine(2, 'p4', 'MOCK-GLZ', 'Mock glaze', Math.ceil(Number(body.p_quantity) * 0.22 * 1000) / 1000, 20),
          ])
        case 'production_save_bom':
          return send(res, 200, { bom_id: 'bom1', bom_code: 'BOM-000001', version: 1 })
        case 'product_sourcing_proposals':
          return send(res, 200, (body.p_product_ids ?? []).filter((id) => id === 'p1').map((id) => ({ product_id: id, sku: 'MOCK-WC-1', product_name: 'Mock Closet 1',
            current_method: 'IN_HOUSE', proposed_method: 'HYBRID', approved_boms: 1, posted_grns: 2, reason: '1 approved BOM version(s), 2 posted GRN(s).' })))
        case 'product_sourcing_apply':
          return send(res, 200, { product_id: body.p_product_id, changed: true, sourcing_method: body.p_method, master_cost: 850 })
        case 'product_cost_set_default_source':
          return send(res, 200, { product_id: body.p_product_id, default_cost_source: body.p_source, master_cost: 850 })
        case 'product_cost_recalculate':
          return send(res, 200, { products: 3, changed: 1 })
        case 'bom_create_similar_products': {
          const created = body.p_products.map((x, i) => ({ product_id: `np${i + 1}`, sku: x.product.sku || `FG-00009${i + 1}`, product_name: x.product.product_name,
            bom_id: `nb${i + 1}`, bom_code: `BOM-00009${i + 1}`, version: 1, status: 'DRAFT', components: x.items.length }))
          return send(res, 200, { created: created.length, products: created })
        }
        case 'bom_generate_multiple': {
          const made = body.p_entries.map((x, i) => {
            const p = x.product_id ? products.find((q) => q.id === x.product_id) : null
            return { product_id: p ? p.id : `np${i + 1}`, sku: p ? p.sku : x.product.sku || `FG-00009${i + 1}`, product_name: p ? p.product_name : x.product.product_name,
              bom_id: `gb${i + 1}`, bom_code: `BOM-00008${i + 1}`, version: p ? 2 : 1, status: 'DRAFT', components: x.items.length, existing_product: Boolean(p) }
          })
          return send(res, 200, { created: made.length, products: made, source: { bom_id: body.p_source.bom_id, bom_code: 'BOM-000001', version: 1 } })
        }
        case 'bom_template_save': {
          const id = body.p_template_id ?? 'tpl-new'
          const t = body.p_template
          tables.bom_templates = tables.bom_templates.filter((x) => x.id !== id).concat([{ id, company_id: COMPANY_ID, template_name: t.template_name, description: t.description ?? null,
            category_id: t.category_id ?? null, output_quantity: t.output_quantity, output_unit: t.output_unit, status: 'ACTIVE', source_bom_id: t.source_bom_id ?? null,
            source_bom_code: t.source_bom_id ? 'BOM-000001' : null, source_bom_version: t.source_bom_id ? 1 : null, created_by: MANAGER_ID, created_at: NOW, updated_at: NOW }])
          tables.bom_template_items = tables.bom_template_items.filter((x) => x.template_id !== id)
            .concat(body.p_items.map((it, i) => ({ id: `${id}-${i + 1}`, company_id: COMPANY_ID, template_id: id, line_no: i + 1, ...it, created_at: NOW })))
          return send(res, 200, { template_id: id, template_name: t.template_name, components: body.p_items.length })
        }
        case 'bom_template_set_status': {
          const t = tables.bom_templates.find((x) => x.id === body.p_template_id)
          if (t) t.status = body.p_status
          return send(res, 200, { template_id: body.p_template_id, status: body.p_status, changed: true })
        }
        case 'production_bom_action':
          return send(res, 200, { status: 'PENDING_APPROVAL', closed_versions: [] })
        case 'production_save_order':
          return send(res, 200, { order_id: 'po1', production_order_number: 'PRD-000009' })
        // V2 Stage 5: sales orders
        case 'sales_dashboard':
          return send(res, 200, { from: body.p_from, to: body.p_to, today: TODAY, total_orders: 12, created_today: 2, this_month: 9, total_value: 845600.5,
            pending: 5, partially_fulfilled: 2, fully_fulfilled: 4, cancelled: 1, awaiting_dispatch: 3,
            by_status: { STOCK_SHORTAGE: 2, READY_FOR_DISPATCH: 3, PARTIALLY_DISPATCHED: 2, FULLY_DISPATCHED: 4, CANCELLED: 1 },
            finished_goods_reserved: [{ unit: 'PCS', quantity: 340 }], production_required: [{ unit: 'PCS', quantity: 70, in_production: 50 }],
            ordered: [{ unit: 'KG', ordered: 50, dispatched: 10, pending: 40 }, { unit: 'PCS', ordered: 900, dispatched: 500, pending: 400 }],
            shortages: [{ product_id: 'p3', sku: 'MOCK-CLAY', product_name: 'Mock ceramic body', unit: 'KG', required: 25, reserved: 10, available: 0, shortage: 15, preferred_supplier_name: 'Shree Clay Works Pvt Ltd', orders: 1 }],
            recent: [{ id: 'so1', sales_order_number: 'SO-000001', order_date: TODAY, customer_name: 'Acme Ltd', grand_total: 118000, status: 'STOCK_SHORTAGE', created_at: NOW }] })
        case 'sales_order_v2_save':
          return send(res, 200, { ...SO_V2, sales_order_number: body.p_so_id ? 'SO-000001' : 'SO-000010', warnings: SO_V2.warnings, changes: [] })
        case 'sales_order_v2_summary':
          return send(res, 200, SO_V2)
        case 'sales_order_v2_reserve':
          return send(res, 200, { ...SO_V2, warnings: [] })
        case 'sales_order_v2_release':
          return send(res, 200, { ...SO_V2, finished_goods_released: 40, materials_released: 10 })
        case 'sales_order_v2_create_production':
          return send(res, 200, { created: [{ line_no: 1, sku: 'MOCK-WC-1', quantity: 10, unit: 'PCS', order_id: 'po1', production_order_number: 'PRD-000011' }], skipped: [], status: 'PRODUCTION_PENDING' })
        case 'sales_order_v2_dispatch':
          return send(res, 200, { dispatches: [{ fulfilment_id: 'f10', fulfilment_number: 'FUL-000010', quantity: 40 }], transaction_numbers: ['TXN-000071'], dispatched_quantity: 40, status: 'PARTIALLY_DISPATCHED' })
        case 'sales_order_v2_reverse_dispatch':
          return send(res, 200, { reversal_numbers: ['TXN-000072'], quantity: 30, status: 'PARTIALLY_DISPATCHED' })
        case 'sales_order_v2_cancel':
          return send(res, 200, { status: 'CANCELLED', released_quantity: 40, materials_released: 10, warnings: [] })
        case 'sales_order_import_preview': {
          const groups = new Map()
          for (const r of body.p_rows) {
            const k = `${r.customer_name}|${r.customer_reference}`
            if (!groups.has(k)) groups.set(k, [])
            groups.get(k).push(r)
          }
          const orders = [...groups.values()].map((rs) => {
            const bad = rs[0].customer_name !== 'Acme Ltd'
            return { first_row: rs[0].row_number, status: bad ? 'ERROR' : 'VALID', errors: bad ? [`Customer "${rs[0].customer_name}" was not found. Add it (Quick Add) and check the file again.`] : [],
              warnings: [], customer_id: bad ? null : 'cu1', customer_name: rs[0].customer_name, customer_code: bad ? null : 'ACME', customer_reference: rs[0].customer_reference,
              order_date: rs[0].order_date, expected_delivery_date: null, estimated_total: 1180 * rs.length,
              rows: rs.map((r) => ({ row_number: r.row_number, sku: r.sku, product_name: 'Mock Closet 1', quantity: Number(r.quantity), unit: 'PCS', unit_price: 1000, errors: [], warnings: [], line_total: 1180 })) }
          })
          return send(res, 200, { orders, rows: body.p_rows.length, valid: orders.filter((o) => o.status === 'VALID').length, warnings: 0,
            errors: orders.filter((o) => o.status === 'ERROR').length, missing_customers: orders.filter((o) => o.status === 'ERROR').map((o) => ({ name: o.customer_name })), missing_products: [] })
        }
        case 'sales_order_import':
          return send(res, 200, { job_id: 'job10', created: [{ first_row: 2, customer_reference: 'PO-1', sales_order_id: 'so1', sales_order_number: 'SO-000011', status: 'READY_FOR_DISPATCH', grand_total: 2360 }],
            failed: [{ first_row: 4, customer_reference: 'N-1', messages: ['Customer "Nobody Ltd" was not found.'] }], created_count: 1, failed_count: 1 })
        // V2 Stage 7: management overview, dashboards, settings, search, activity, reconciliation, reports
        case 'inventory_stock_value_summary':
          return send(res, 200, stockValueSummary(body.p_unit, body.p_search))
        case 'management_overview':
          return send(res, 200, MGMT_OVERVIEW(body.p_from, body.p_to))
        case 'module_dashboard':
          return send(res, 200, MODULE_DASHBOARDS[body.p_module] ?? null)
        case 'support_channel_status':
          return send(res, 200, SUPPORT_CHANNELS)
        case 'support_overview':
          return send(res, 200, SUPPORT_OVERVIEW(body.p_from, body.p_to))
        case 'support_reports':
          return send(res, 200, { ...SUPPORT_OVERVIEW(body.p_from, body.p_to), by_category: [{ category: 'Damage', tickets: 1 }], by_priority: [{ priority: 'URGENT', tickets: 1 }],
            calls: { inbound: 1, outbound: 0, answered: 0, missed: 1, avg_duration_seconds: null }, messages: { whatsapp_inbound: 1, whatsapp_outbound: 0, email_inbound: 0, email_outbound: 0 },
            csat: [{ rating: 5, tickets: 1 }], reopened: 0 })
        case 'support_inbox': {
          const rows = SUPPORT_INBOX.filter((r) => (!body.p_channel || r.channel === body.p_channel) && (body.p_view === 'ALL' || body.p_view === r.channel || body.p_view === r.status
            || (body.p_view === 'UNASSIGNED' && !r.assigned_agent_id) || (body.p_view === 'MINE' && r.assigned_agent_id === 'sag1'))
            && (!body.p_search || JSON.stringify(r).toLowerCase().includes(String(body.p_search).toLowerCase())))
          return send(res, 200, { total: rows.length, me: 'sag1', rows, counts: { ALL: 2, UNASSIGNED: 1, MINE: 1, OPEN: 1, PENDING: 1, UNREAD: 2 } })
        }
        case 'bom_component_search': {
          const t = String(body.p_term ?? '').toLowerCase()
          return send(res, 200, Object.values(BULK_COMPS).filter((c) => `${c.sku} ${c.product_name} ${c.barcode ?? ''} ${c.model_number ?? ''}`.toLowerCase().includes(t)))
        }
        case 'bom_where_used': {
          const comp = BULK_COMPS[body.p_component]
          if (!comp) return send(res, 400, { code: 'P0001', message: 'Component not found in your company.' })
          const all = body.p_component === 'cmp-old' ? BULK_BOMS : []
          const f = body.p_filters ?? {}
          const rows = all.filter((r) => !f.search || `${r.sku} ${r.product_name}`.toLowerCase().includes(String(f.search).toLowerCase()))
          return send(res, 200, { component: comp, total: rows.length, rows: rows.slice(body.p_offset ?? 0, (body.p_offset ?? 0) + (body.p_limit ?? 50)),
            stats: { current_boms: rows.length, products: rows.length, total_quantity_current: rows.reduce((a, r) => a + r.quantity, 0), unit_mismatches: 0 } })
        }
        case 'bom_bulk_current_boms':
          return send(res, 200, BULK_BOMS.map((r) => ({ bom_id: r.bom_id, bom_code: r.bom_code, version: r.version, lifecycle: 'ACTIVE', effective_from: TODAY, finished_product_id: r.finished_product_id, sku: r.sku, product_name: r.product_name, product_type: r.product_type, item_count: 2 })))
        case 'bom_bulk_resolve_skus': {
          const known = { 'fg-basin-1': { product_id: 'fgb1', sku: 'FG-BASIN-1', current_bom_id: 'bb1' }, 'pk-box-01': { product_id: 'cmp-box', sku: 'PK-BOX-01', current_bom_id: null } }
          return send(res, 200, (body.p_skus ?? []).map((x) => String(x).toLowerCase()).filter((k) => known[k]).map((k) => ({ sku_key: k, ...known[k], product_name: known[k].sku,
            base_unit: 'PCS', product_type: k.startsWith('fg') ? 'FINISHED_GOOD' : 'PACKAGING_MATERIAL', status: 'ACTIVE', current_bom_code: known[k].current_bom_id ? 'BOM-000101' : null, current_version: known[k].current_bom_id ? 1 : null })))
        }
        case 'bom_change_batch_save': {
          if (!has('production_bom.create') && !has('production_bom.update')) return send(res, 403, { code: '42501', message: 'requires production_bom.create or production_bom.update' })
          BULK.saves.push(body)
          const h = body.p_header
          const n = BULK.batches.length + 1
          const lines = body.p_lines.map((l, i) => {
            const src = BULK_BOMS.find((r) => r.bom_id === l.bom_id || r.finished_product_id === l.finished_product_id) ?? BULK_BOMS[0]
            const nc = BULK_COMPS[l.new_component_product_id]
            const q = h.operation === 'DELETE' ? null : l.quantity ? Number(l.quantity) : src.quantity * Number(l.factor ?? 1)
            return { id: `bl${n}-${i}`, line_no: i + 1, action: h.operation, source_bom_id: src.bom_id, bom_code: src.bom_code, source_version: 1, finished_product_id: src.finished_product_id,
              finished_sku: src.sku, finished_name: src.product_name, component_product_id: l.component_product_id, component_sku: BULK_COMPS[l.component_product_id]?.sku ?? null,
              component_name: BULK_COMPS[l.component_product_id]?.product_name ?? null, new_component_product_id: nc?.product_id ?? null, new_component_sku: nc?.sku ?? null,
              new_component_name: nc?.product_name ?? null, restore_from_bom_id: null, input: l, old_quantity: h.operation === 'ADD' ? null : src.quantity, new_quantity: q,
              old_unit: h.operation === 'ADD' ? null : 'KG', new_unit: h.operation === 'DELETE' ? null : (nc?.base_unit ?? BULK_COMPS[l.component_product_id]?.base_unit ?? 'KG'),
              old_wastage: h.operation === 'ADD' ? null : 2, new_wastage: h.operation === 'DELETE' ? null : Number(l.wastage_percentage ?? 2), old_notes: null, new_notes: null,
              validation_errors: [], warnings: [], result_bom_id: null, result_version: null }
          })
          const b = { id: `bcb${n}`, batch_number: `BCB-00000${n}`, operation: h.operation, status: 'DRAFT', title: h.title ?? null, reason: h.reason, effective_from: h.effective_from,
            merge_duplicates: !!h.merge_duplicates, restores_batch_id: null, summary: { boms: new Set(lines.map((l) => l.source_bom_id)).size, boms_valid: lines.length, lines: lines.length, lines_with_errors: 0, lines_with_warnings: 0, products_with_errors: [] },
            row_version: 1, last_error: null, created_at: NOW, created_by_name: 'Smoke Tester', submitted_at: null, approved_at: null, approval_note: null, rejected_at: null, rejection_reason: null, published_at: null,
            lines, events: [] }
          bulkEvent(b, 'CREATED', h.reason)
          BULK.batches.push(b)
          return send(res, 200, bulkDetail(b))
        }
        case 'bom_change_batch_get':
        case 'bom_change_batch_validate': {
          const b = BULK.batches.find((x) => x.id === body.p_batch_id)
          return b ? send(res, 200, bulkDetail(b)) : send(res, 400, { code: 'P0001', message: 'Change batch not found in your company.' })
        }
        case 'bom_change_batch_action': {
          const b = BULK.batches.find((x) => x.id === body.p_batch_id)
          const next = { SUBMIT: 'PENDING_APPROVAL', APPROVE: 'APPROVED', REJECT: 'REJECTED', WITHDRAW: 'DRAFT', CANCEL: 'CANCELLED' }[body.p_action]
          if (!b || !next) return send(res, 400, { code: 'P0001', message: 'Unknown action.' })
          if (body.p_expected_version !== null && body.p_expected_version !== b.row_version) return send(res, 409, { code: '40001', message: 'This batch was changed by someone else. Reload it and try again.' })
          b.status = next
          if (next === 'PENDING_APPROVAL') b.submitted_at = NOW
          if (next === 'APPROVED') { b.approved_at = NOW; b.approved_by_name = 'Smoke Tester' }
          bulkEvent(b, { SUBMIT: 'SUBMITTED', APPROVE: 'APPROVED', REJECT: 'REJECTED', WITHDRAW: 'WITHDRAWN', CANCEL: 'CANCELLED' }[body.p_action], body.p_note)
          return send(res, 200, bulkDetail(b))
        }
        case 'bom_change_batch_publish': {
          const b = BULK.batches.find((x) => x.id === body.p_batch_id)
          if (!b || b.status !== 'APPROVED') return send(res, 400, { code: 'P0001', message: 'Only an approved batch can be published.' })
          BULK.published++
          b.status = 'PUBLISHED'
          b.published_at = NOW
          b.lines.forEach((l) => { l.result_bom_id = `${l.source_bom_id}-v2`; l.result_version = 2 })
          bulkEvent(b, 'PUBLISHED')
          return send(res, 200, { ok: true, revisions: b.lines.map((l) => ({ bom_code: l.bom_code, from_version: 1, to_version: 2, bom_id: l.result_bom_id })), batch: bulkDetail(b) })
        }
        case 'bom_change_batches_list': {
          const counts = {}
          for (const b of BULK.batches) counts[b.status] = (counts[b.status] ?? 0) + 1
          const rows = BULK.batches.filter((b) => !body.p_status || b.status === body.p_status).map((b) => ({ id: b.id, batch_number: b.batch_number, operation: b.operation, status: b.status, title: b.title,
            reason: b.reason, effective_from: b.effective_from, summary: b.summary, created_at: b.created_at, created_by_name: 'Smoke Tester', submitted_at: b.submitted_at, approved_at: b.approved_at,
            published_at: b.published_at, approved_by_name: b.approved_by_name ?? null, stale: false, last_error: null }))
          return send(res, 200, { total: rows.length, counts, rows })
        }
        case 'bom_revision_log': {
          const rows = BULK.batches.filter((b) => b.status === 'PUBLISHED').flatMap((b) => b.lines.map((l) => ({ bom_id: l.result_bom_id, bom_code: l.bom_code, version: 2, status: 'APPROVED', lifecycle: 'ACTIVE',
            effective_from: b.effective_from, effective_to: null, finished_product_id: l.finished_product_id, sku: l.finished_sku, product_name: l.finished_name,
            change_reason: `${b.batch_number} Replace: ${b.reason}`, review_note: null, created_at: NOW, approved_at: NOW, created_by_name: 'Smoke Tester', approved_by_name: 'Smoke Tester',
            previous_bom_id: l.source_bom_id, item_count: 2, batch_id: b.id, batch_number: b.batch_number, batch_operation: b.operation })))
          return send(res, 200, { total: rows.length, rows })
        }
        case 'support_phone_softphone_status':
          return send(res, 200, SOFTPHONE_STATUS())
        case 'support_call_context':
          return send(res, 200, CALL_CONTEXT())
        case 'support_call_note_add':
          SOFT.notes.push(body.p_body)
          return send(res, 200, `note${SOFT.notes.length}`)
        case 'support_call_link_ticket':
          SOFT.links.push([body.p_call, body.p_ticket])
          return send(res, 200, null)
        case 'support_call_analytics':
          return has('support.view_reports') ? send(res, 200, CALL_ANALYTICS(body.p_from, body.p_to, body.p_group)) : send(res, 403, { code: '42501', message: 'requires support.view_reports' })
        case 'support_call_lines':
          return send(res, 200, has('support.reply') ? [{ id: 'pl1', agent_number: '0501234567', label: 'Desk', agent_name: 'Smoke Agent', presence: 'AVAILABLE', mine: true }] : [])
        case 'support_call_list': {
          const f = body.p ?? {}
          const rows = PHONE_CALLS.filter((c) => (!f.direction || c.direction === f.direction) && (!f.status || c.status === f.status)
            && (!f.search || JSON.stringify(c).toLowerCase().includes(String(f.search).toLowerCase()))).map((c) => ({ ...c, idem: undefined }))
          return send(res, 200, { total: rows.length, rows: rows.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 25)) })
        }
        case 'support_call_detail':
          return send(res, 200, PHONE_DETAIL(body.p_id))
        case 'support_live_calls':
          return send(res, 200, has('support.reply') ? PHONE_LIVE : [])
        case 'support_phone_config_get':
          return has('support.manage_integrations') ? send(res, 200, PHONE_CONFIG) : send(res, 403, { code: '42501', message: 'You are not allowed to perform this action (requires support.manage_integrations).' })
        case 'support_phone_config_save':
          if (body.p && ('api_token' in body.p || 'status' in body.p)) return send(res, 400, { code: 'P0001', message: 'Secrets are not accepted here.' })
          Object.assign(PHONE_CONFIG.config, body.p)
          return send(res, 200, PHONE_CONFIG)
        case 'support_phone_agent_save':
          return send(res, 200, 'pl1')
        case 'support_acefone_replay':
          PHONE_CONFIG.events[0].processing_result = 'PROCESSED'
          PHONE_CONFIG.events[0].replay_count++
          return send(res, 200, { result: 'PROCESSED', changed: false })
        case 'support_phone_disconnect':
          PHONE_CONFIG.config.is_enabled = false
          PHONE_CONFIG.config.disconnected_at = new Date().toISOString()
          return send(res, 200, null)
        case 'support_ticket_fields_admin': case 'support_ticket_form': case 'support_ticket_extras': case 'support_ticket_field_save': case 'support_ticket_fields_save_layout':
        case 'support_ticket_create_v2': case 'support_ticket_product_search': case 'support_ticket_custom_fields_save': case 'support_ticket_products_save': case 'support_ticket_user_options':
        case 'support_ticket_lookup_search': {
          if (!TF.on) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${fn}` })
          if (fn === 'support_ticket_fields_admin') {
            return send(res, 200, { stamp: TF.stamp, max_custom: 25, active_custom: TF.defs.filter((d) => d.is_active).length, standard: TF_STANDARD, definitions: TF.defs,
              layout: tfLayout().map((l, i) => ({ ...l, display_order: (i + 1) * 10 })), can: { create: true, update: true, delete: true } })
          }
          if (fn === 'support_ticket_form') return send(res, 200, tfForm())
          if (fn === 'support_ticket_field_save') {
            TF.fieldSaves.push(body)
            if (body.p_id) { const d = TF.defs.find((x) => x.id === body.p_id); Object.assign(d, body.p); return send(res, 200, d) }
            const d = tfDef(`tfd${TF.defs.length + 1}`, `cf_${body.p.field_label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`, body.p.field_label, body.p.field_type,
              body.p.field_type === 'CURRENCY' ? { currency: 'INR', ...body.p.field_config } : body.p.field_config, { is_required: body.p.is_required, help_text: body.p.help_text })
            TF.defs.push(d)
            return send(res, 200, d)
          }
          if (fn === 'support_ticket_fields_save_layout') {
            TF.saves.push(body)
            if (body.p_stamp !== TF.stamp) return send(res, 400, { code: 'P0001', message: 'Someone else changed the ticket fields since you opened this page. Reload to see their changes, then make yours again.' })
            const vis = body.p_used.map((x) => ({ standard_key: x.standard_key ?? null, field_definition_id: x.field_definition_id ?? null, is_required_override: x.is_required ?? null, is_visible: true }))
            const hidden = [...TF_STANDARD.filter((x) => !vis.some((v) => v.standard_key === x.standard_key)).map((x) => ({ standard_key: x.standard_key, field_definition_id: null, is_required_override: null, is_visible: false })),
              ...TF.defs.filter((d) => !vis.some((v) => v.field_definition_id === d.id)).map((d) => ({ standard_key: null, field_definition_id: d.id, is_required_override: null, is_visible: false }))]
            TF.layout = [...vis, ...hidden]
            TF.stamp = `s${TF.saves.length}`
            return send(res, 200, { stamp: TF.stamp })
          }
          if (fn === 'support_ticket_create_v2') {
            TF.creates.push(body.p)
            TF.values = Object.fromEntries(Object.entries(body.p.custom_fields).filter(([, v]) => v !== null).map(([k, v]) => {
              const d = TF.defs.find((x) => x.field_key === k)
              return [k, d?.field_type === 'PICKLIST' ? { id: v, label: d.field_config.options.find((o) => o.id === v)?.label } : d?.field_type === 'NUMBER' ? Number(v) : v]
            }))
            TF.links = body.p.products.map((x, i) => { const c = TF_CATALOGUE.find((y) => y.id === x.product_id); return { id: `tl${i}`, product_id: c.id, quantity: Number(x.quantity), product_name: c.product_name, sku: c.sku,
              product_name_snapshot: c.product_name, sku_snapshot: c.sku, model_number: c.model_number, barcode: c.barcode, ean: c.ean, base_unit: c.base_unit, archived: false, added_at: NOW, added_by: 'Smoke Tester' } })
            return send(res, 200, { id: 'st9', ticket_number: 'ALT-SUP-000009', custom_fields: Object.keys(TF.values).length, products: TF.links.length })
          }
          if (fn === 'support_ticket_extras') {
            return send(res, 200, { fields: TF.defs.filter((d) => d.is_active).map((d) => ({ ...d, value: TF.values[d.field_key] ?? null, in_form: true, required: d.is_required })),
              formula_inputs: {}, products: TF.links, can: { edit_fields: true, manage_products: true, archived_products: false } })
          }
          if (fn === 'support_ticket_custom_fields_save') {
            TF.fieldSaves.push(body)
            for (const [k, v] of Object.entries(body.p_values)) { const d = TF.defs.find((x) => x.field_key === k); TF.values[k] = d?.field_type === 'NUMBER' ? Number(v) : v }
            return send(res, 200, { changed: Object.keys(body.p_values) })
          }
          if (fn === 'support_ticket_products_save') {
            TF.productSaves.push(body)
            const removed = TF.links.filter((l) => !body.p_items.some((x) => x.product_id === l.product_id)).map((l) => l.sku)
            TF.links = TF.links.filter((l) => body.p_items.some((x) => x.product_id === l.product_id)).map((l) => ({ ...l, quantity: Number(body.p_items.find((x) => x.product_id === l.product_id).quantity) }))
            return send(res, 200, { added: [], removed, changed: [] })
          }
          if (fn === 'support_ticket_product_search') {
            const t = String(body.p_term).toLowerCase()
            return send(res, 200, TF_CATALOGUE.filter((c) => [c.sku, c.product_name, c.model_number, c.barcode, c.ean].some((x) => x && x.toLowerCase().includes(t))))
          }
          if (fn === 'support_ticket_user_options') return send(res, 200, [{ id: MANAGER_ID, name: 'Smoke Tester', is_agent: true }])
          return send(res, 200, [])
        }
        case 'support_live_summary':
          if (!LIVE.on) return send(res, 404, { code: 'PGRST202', message: 'Could not find the function public.support_live_summary' })
          return send(res, 200, LIVE.summary)
        case 'support_calls_mark_handled':
          if (!LIVE.on) return send(res, 404, { code: 'PGRST202', message: 'Could not find the function public.support_calls_mark_handled' })
          LIVE.handled.push(body.p_ids ?? null)
          { const n = LIVE.summary.missed_calls; LIVE.summary = { ...LIVE.summary, missed_calls: 0, stamps: { ...LIVE.summary.stamps, calls: `c${Date.now()}` } }
            return send(res, 200, { handled: n }) }
        case 'support_gmail_schedule_status':
          if (!SYNC.schedule) return send(res, 404, { code: 'PGRST202', message: 'Could not find the function public.support_gmail_schedule_status' })
          return send(res, 200, SYNC.schedule)
        case 'support_email_sync_status':
          if (!SYNC.status) return send(res, 404, { code: 'PGRST202', message: 'Could not find the function public.support_email_sync_status' })
          return send(res, 200, SYNC.status)
        case 'support_email_config_get':
          return has('support.manage_integrations') ? send(res, 200, GMAIL_CONFIG()) : send(res, 403, { code: '42501', message: 'You are not allowed to perform this action (requires support.manage_integrations).' })
        case 'support_email_config_save':
          if (body.p && ('refresh_token' in body.p || 'status' in body.p || 'password' in body.p)) return send(res, 400, { code: 'P0001', message: 'Passwords, tokens and secrets are never saved here.' })
          return send(res, 200, GMAIL_CONFIG())
        case 'support_email_templates_list':
          return send(res, 200, [{ id: 'tpl1', name: 'Replacement', subject: 'Your replacement', body: 'We are sending a replacement today.', is_active: true, updated_at: NOW }])
        case 'support_email_compose_context':
          return send(res, 200, { configured: true, status: GMAIL.connected ? 'CONNECTED' : 'SETUP_REQUIRED', can_send: GMAIL.connected && has('support.reply'), mailbox: 'support@alton.example',
            display_name: 'Alton Support', signature: 'Alton Support Team', mailbox_modify: false, max_attachment_mb: 10,
            templates: [{ id: 'tpl1', name: 'Replacement', subject: 'Your replacement', body: 'We are sending a replacement today.' }] })
        // Email workspace (20261222090000); served only by its own step, so other steps see the pre-migration fallback.
        case 'support_email_mailbox':
          if (!MAILBOX.web) return send(res, 404, { code: 'PGRST202', message: 'Could not find the function public.support_email_mailbox' })
          MAILBOX.queries.push(body.p)
          return send(res, 200, MAILBOX_PAGE(body.p))
        case 'support_email_mailbox_action': {
          if (!MAILBOX.web) return send(res, 404, { code: 'PGRST202', message: 'Could not find the function public.support_email_mailbox_action' })
          if (!has('support.reply')) return send(res, 403, { code: '42501', message: 'requires support.reply' })
          MAILBOX.actions.push({ ids: body.p_ids, action: body.p_action, p: body.p })
          for (const id of body.p_ids) {
            const st = MAILBOX.state[id] ?? (MAILBOX.state[id] = { starred: false, important: false, folder: 'INBOX' })
            if (body.p_action === 'STAR' || body.p_action === 'UNSTAR') st.starred = body.p_action === 'STAR'
            if (['ARCHIVE', 'INBOX', 'SPAM', 'TRASH'].includes(body.p_action)) st.folder = body.p_action
          }
          return send(res, 200, { updated: body.p_ids.length, action: body.p_action })
        }
        case 'support_email_list_attachments':
          if (!MAILBOX.web) return send(res, 404, { code: 'PGRST202', message: 'Could not find the function public.support_email_list_attachments' })
          return send(res, 200, Object.fromEntries((body.p_ids ?? []).filter((id) => MAILBOX.files[id]).map((id) => [id, MAILBOX.files[id]])))
        case 'support_email_message_state':
          if (!MAILBOX.web) return send(res, 404, { code: 'PGRST202', message: 'Could not find the function public.support_email_message_state' })
          return send(res, 200, MAILBOX.msg[body.p_conversation] ?? { starred: false, starred_emails: [] })
        case 'support_email_message_action': {
          if (!MAILBOX.web) return send(res, 404, { code: 'PGRST202', message: 'Could not find the function public.support_email_message_action' })
          if (!has('support.reply')) return send(res, 403, { code: '42501', message: 'requires support.reply' })
          MAILBOX.msgActions.push(body)
          const st = MAILBOX.msg['sc-mail'] ?? (MAILBOX.msg['sc-mail'] = { starred: false, starred_emails: [] })
          if (body.p_action === 'STAR') { st.starred_emails = st.starred ? [...new Set([...st.starred_emails, body.p_email])] : [body.p_email]; st.starred = true }
          if (body.p_action === 'UNSTAR') { st.starred_emails = st.starred_emails.filter((x) => x !== body.p_email); st.starred = st.starred_emails.length > 0 }
          const box = MAILBOX.state['sc-mail'] ?? (MAILBOX.state['sc-mail'] = { starred: false, important: false, folder: 'INBOX' })
          box.starred = st.starred
          if (body.p_action.startsWith('REPORT_')) box.folder = 'SPAM'
          return send(res, 200, { ...st, folder: box.folder, action: body.p_action, email_id: body.p_email, conversation_id: 'sc-mail' })
        }
        case 'erp_form_drafts_mine':
          return send(res, 200, [...formDrafts.entries()].filter(([k, r]) => k.startsWith(`${currentUser?.id}|`) && r.status === 'draft')
            .map(([k, r]) => ({ form_key: r.form_key, scope: k.split('|')[3], last_saved_at: r.last_saved_at, version: r.version })))
        case 'support_email_thread':
          return send(res, 200, body.p_conversation === 'sc-mail' ? GMAIL_THREAD : [])
        case 'support_email_html':
          return send(res, 200, '<p>The basin arrived <b>cracked</b>.</p><a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">order</a>')
        case 'support_whatsapp_config_get':
          return has('support.manage_integrations') ? send(res, 200, WA_CONFIG()) : send(res, 403, { code: '42501', message: 'You are not allowed to perform this action (requires support.manage_integrations).' })
        case 'support_whatsapp_config_save':
          if (body.p && ['access_token', 'app_secret', 'verify_token', 'setup_state'].some((k) => k in body.p)) return send(res, 400, { code: 'P0001', message: 'Secrets are never saved here.' })
          return send(res, 200, WA_CONFIG())
        case 'support_whatsapp_checklist_set':
          if (body.p_done && !WA.checklist.includes(body.p_key)) WA.checklist.push(body.p_key)
          return send(res, 200, WA_CONFIG())
        case 'support_whatsapp_set_enabled':
          if (body.p_enabled && WA.preflight && !WA.preflight().can_activate) return send(res, 400, { code: 'P0001', message: `WhatsApp cannot be switched on yet (eligibility blocked): ${WA.preflight().blockers.join(' | ')}` })
          if (body.p_enabled && WA.state !== 'CONNECTED') return send(res, 400, { code: 'P0001', message: 'WhatsApp cannot be switched on yet: the setup state is migration required.' })
          WA.enabled = Boolean(body.p_enabled)
          return send(res, 200, WA_CONFIG())
        case 'support_whatsapp_event_replay':
          return send(res, 200, { result: 'PROCESSED', messages: 1 })
        case 'support_whatsapp_status_context':
          return send(res, 200, { setup_state: WA.state, enabled: WA.enabled, display_phone_number: '+9118001234567', can_send: WA.enabled && has('support.reply') })
        case 'support_whatsapp_thread':
          return send(res, 200, body.p_conversation === 'sc-wa' ? WA_THREAD() : null)
        // WhatsApp Web screen (20261221090000); served only by its own step, so other steps see the pre-migration fallback.
        case 'support_whatsapp_inbox':
          if (!WA.web) return send(res, 404, { code: 'PGRST202', message: 'Could not find the function public.support_whatsapp_inbox' })
          return send(res, 200, WA_WEB_INBOX(body))
        case 'support_conversation_pref_set': {
          if (!WA.web) return send(res, 404, { code: 'PGRST202', message: 'Could not find the function public.support_conversation_pref_set' })
          WA.prefCalls.push(body)
          const cur = WA.prefs[body.p_conversation] ?? { pinned: false, muted: false, favorite: false }
          const next = { pinned: body.p_pinned ?? cur.pinned, muted: body.p_muted ?? cur.muted, favorite: body.p_favorite ?? cur.favorite }
          WA.prefs[body.p_conversation] = next
          return send(res, 200, next)
        }
        case 'support_whatsapp_message_info':
          if (!WA.web) return send(res, 404, { code: 'PGRST202', message: 'Could not find the function public.support_whatsapp_message_info' })
          return send(res, 200, WA_MESSAGE_INFO(body.p_id))
        case 'support_whatsapp_templates_list':
          return send(res, 200, WA_TEMPLATES)
        case 'support_automation_settings_get':
          return has('support.view') ? send(res, 200, UNI_SETTINGS()) : send(res, 403, { code: '42501', message: 'requires support.view' })
        case 'support_ticket_rules_save':
          if (!has('support.manage_settings')) return send(res, 403, { code: '42501', message: 'requires support.manage_settings' })
          UNI.rulesSaves.push(body.p)
          return send(res, 200, UNI_SETTINGS())
        case 'support_business_calendar_save':
          UNI.calendarSaves.push(body.p)
          return send(res, 200, UNI_SETTINGS())
        case 'support_holiday_save': case 'support_escalation_level_save': case 'support_assignment_rule_save':
          return send(res, 200, UNI_SETTINGS())
        case 'support_sla_run_now':
          return send(res, 200, { warnings: 1, breaches: 1, escalations: 0 })
        case 'support_ticket_sla':
          return send(res, 200, UNI_TICKET_SLA)
        case 'support_reports_unified':
          return has('support.view_reports') ? send(res, 200, UNI_REPORTS(body.p_from, body.p_to)) : send(res, 403, { code: '42501', message: 'requires support.view_reports' })
        case 'support_integration_health':
          return has('support.manage_integrations') ? send(res, 200, UNI_HEALTH()) : send(res, 403, { code: '42501', message: 'requires support.manage_integrations' })
        case 'support_conversation_detail':
          return send(res, 200, SUPPORT_CONVERSATION(body.p_id))
        case 'support_conversation_create':
          return send(res, 200, { id: 'sc2', message_id: 'm9', customer_id: null, match: 'AMBIGUOUS', candidates: [{ id: 'scu1', matched_on: ['phone'] }, { id: 'scu2', matched_on: ['phone'] }] })
        case 'support_message_add':
          if (body.p?.mode === 'REPLY') return send(res, 400, { code: 'P0001', message: 'Cannot reply through Whatsapp : the channel is setup required.', details: null, hint: null })
          return send(res, 200, { id: 'm10', delivery_status: null })
        case 'support_note_add':
          return send(res, 200, 'n9')
        case 'support_conversation_update': case 'support_conversation_assign': case 'support_conversation_set_tags': case 'support_conversation_mark_read':
        case 'support_conversation_link_customer': case 'support_ticket_update': case 'support_ticket_assign': case 'support_ticket_merge': case 'support_ticket_reopen':
        case 'support_ticket_link_conversation': case 'support_agent_set_presence':
          return send(res, 200, null)
        case 'support_ticket_list': {
          const f = body.p ?? {}
          const rows = SUPPORT_TICKETS.filter((t) => (!f.status || t.status === f.status) && (!f.statuses || f.statuses.includes(t.status)) && (!f.search || JSON.stringify(t).toLowerCase().includes(String(f.search).toLowerCase())))
          return send(res, 200, { total: rows.length, rows })
        }
        case 'support_ticket_detail':
          return send(res, 200, SUPPORT_TICKET_DETAIL(body.p_id))
        case 'support_ticket_create':
          return send(res, 200, { id: 'st9', ticket_number: 'ALT-SUP-000009' })
        case 'support_customer_list':
          return send(res, 200, { total: 1, rows: [{ id: 'scu1', customer_code: 'SC-000001', display_name: 'Ravi Kumar', company_name: null, phones: ['+91 98765 43210'], emails: [],
            erp_customer_id: 'cu1', erp_customer_code: 'ACME', open_tickets: 1, conversations: 1, last_activity_at: NOW }] })
        case 'support_customer_profile':
          return send(res, 200, { customer: { id: 'scu1', customer_code: 'SC-000001', display_name: 'Ravi Kumar', company_name: null, phones: ['+91 98765 43210'], emails: [], address: null,
              erp_customer_id: 'cu1', notes: null, created_at: NOW },
            erp_customer: { id: 'cu1', customer_code: 'ACME', customer_name: 'Acme Ltd', contact_email: null, gstin: null, billing_address: null, status: 'ACTIVE' },
            tickets: SUPPORT_TICKETS.map((t) => ({ id: t.id, ticket_number: t.ticket_number, subject: t.subject, status: t.status, priority: t.priority, channel: t.channel, created_at: t.created_at, sla_status: t.sla_status })),
            conversations: [{ id: 'sc1', channel: 'WHATSAPP', subject: 'Cracked basin', status: 'OPEN', last_message_preview: 'Basin arrived cracked', last_activity_at: NOW }],
            calls: [{ id: 'm1', conversation_id: 'sc2', direction: 'INBOUND', call_status: 'MISSED', duration_seconds: null, occurred_at: NOW, summary: null, source: 'MANUAL' }],
            emails: [], notes: [], orders: [{ id: 'so1', number: 'SO-000001', order_date: TODAY, status: 'CONFIRMED', value: 118000 }], invoices: null })
        case 'support_agent_workspace':
          return send(res, 200, { agent: { id: 'sag1', user_id: MANAGER_ID, display_name: 'Smoke Agent', department: null, presence: 'AVAILABLE', is_active: true, max_open_conversations: 25 },
            workload: { open_conversations: 1, unread: 2, open_tickets: 1, overdue_tickets: 0, capacity: 25 },
            conversations: [{ id: 'sc1', channel: 'WHATSAPP', subject: 'Cracked basin', status: 'OPEN', priority: 'URGENT', customer_name: 'Ravi Kumar', unread_count: 2, last_activity_at: NOW }],
            tickets: [{ id: 'st1', ticket_number: 'ALT-SUP-000001', subject: 'Cracked basin on delivery', status: 'OPEN', priority: 'URGENT', due_at: NOW, sla_status: 'AT_RISK' }],
            performance: { resolved: 1, avg_resolution_minutes: 200, avg_first_response_minutes: 42, sla_met: 1, sla_breached: 0, csat_avg: 5 },
            activity: [{ id: 'al1', action: 'tickets.insert', entity_type: 'tickets', entity_id: 'st1', details: {}, at: NOW }] })
        case 'support_channel_account_save':
          return send(res, 200, { id: 'sca2', channel: body.p?.channel ?? 'EMAIL', display_name: body.p?.display_name, status: 'SETUP_REQUIRED' })
        case 'gst_exclusive_dashboard':
          return send(res, 200, EXCL_GST(body.p_scope))
        case 'erp_settings_get':
          return send(res, 200, ERP_SETTINGS)
        // Preferences (ERP settings values read by every screen). Served only where a step needs them; elsewhere the
        // screens keep their built-in defaults, as before.
        case 'erp_preferences':
          if (!SERVE_PREFERENCES) return send(res, 404, { code: 'PGRST202', message: 'Could not find the function public.erp_preferences' })
          return send(res, 200, ERP_SETTINGS.settings)
        case 'product_purchase_costs':
          return send(res, 200, (body.p_ids ?? []).filter((id) => id === 'p1').map(() => ({ product_id: 'p1', last_cost: PC_HISTORY.current.cost, last_date: TODAY,
            previous_cost: PC_HISTORY.current.previous_cost, difference: PC_HISTORY.current.difference, change_percent: PC_HISTORY.current.change_percent,
            change_type: PC_HISTORY.current.change_type, supplier_name: 'Morbi Tiles LLP', supplier_last_cost: body.p_supplier ? 870 : null,
            supplier_last_date: body.p_supplier ? '2026-10-01' : null, threshold: 10 })))
        case 'product_purchase_cost_history': {
          if (body.p_product_id !== 'p1') return send(res, 200, { ...PC_HISTORY, product: { ...PC_HISTORY.product, id: body.p_product_id }, current: null, events: [] })
          return send(res, 200, { ...PC_HISTORY, events: PC_EVENTS })
        }
        case 'product_purchase_cost_override': {
          if (String(body.p_reason ?? '').trim().length < 5) return send(res, 400, { code: 'P0001', message: 'Enter the reason for the override (at least 5 characters).' })
          const prev = PC_HISTORY.current.cost
          PC_EVENTS.unshift(pcEvent('pce-ov', { event_type: 'MANUAL_OVERRIDE', previous_cost: prev, new_cost: body.p_cost, difference: body.p_cost - prev,
            change_percent: Math.round(((body.p_cost - prev) / prev) * 10000) / 100, change_type: body.p_cost > prev ? 'INCREASE' : 'DECREASE', supplier_id: null, supplier_name: null,
            purchase_order_id: null, po_number: null, goods_receipt_id: null, receipt_number: null, received_quantity: null, reason: 'Manual override: ' + body.p_reason,
            effective_date: TODAY, created_at: `${TODAY}T13:00:00Z` }))
          Object.assign(PC_HISTORY.current, { cost: body.p_cost, previous_cost: prev, difference: body.p_cost - prev, change_type: body.p_cost > prev ? 'INCREASE' : 'DECREASE' })
          return send(res, 200, { event_id: 'pce-ov', cost: body.p_cost })
        }
        case 'product_import_match_key':
          return send(res, 200, ERP_SETTINGS.settings['product.import_match_key'] ?? 'SKU')
        case 'erp_settings_save': {
          if (body.p_settings?.['numbering.po_prefix'] === 'X') return send(res, 400, { code: 'P0001', message: 'Number prefixes are 2 to 5 capital letters (e.g. PO).' })
          Object.assign(ERP_SETTINGS.company, body.p_company ?? {})
          Object.assign(ERP_SETTINGS.settings, body.p_settings ?? {})
          return send(res, 200, ERP_SETTINGS)
        }
        // ERP search RPCs (20261231090900): every word in the row or its related records (BOM components).
        case 'bom_search':
          return send(res, 200, mockStatus(mockSearch(tables.bom_list_v2 ?? [], body.p_search, (b) => (tables.bom_item_list ?? []).filter((i) => i.bom_id === b.id)), body.p_status))
        case 'production_order_search':
          return send(res, 200, mockStatus(mockSearch(tables.production_order_list ?? [], body.p_search), body.p_status))
        case 'outsourcing_order_search':
          return send(res, 200, mockStatus(mockSearch(tables.outsourcing_order_list ?? [], body.p_search), body.p_status))
        case 'global_search':
          return send(res, 200, String(body.p_term).toLowerCase().includes('wc') ? [
            { module: 'Product', id: 'p1', reference: 'MOCK-WC-1', title: 'Mock Closet 1', subtitle: 'Finished good · HSN 6910', link: '/products/p1' },
            { module: 'Sales order', id: 'so1', reference: 'SO-000001', title: 'Acme Ltd', subtitle: TODAY, link: '/sales/orders/so1' },
          ] : [])
        case 'activity_feed': {
          const rows = [
            { type: 'INVOICE_CREATED', at: NOW, reference: 'INV/26-27/0001', description: 'Invoice issued · Acme Ltd · 2242', link: '/billing/invoices/inv2' },
            { type: 'PAYMENT_RECEIVED', at: NOW, reference: 'RCT/26-27/0001', description: 'Payment received from Acme Ltd · 1221', link: '/billing/payments' },
            { type: 'GOODS_RECEIVED', at: NOW, reference: 'GRN-000001', description: 'Goods received from Shree Clay Works', link: '/goods-receipts/gr1' },
          ].filter((r) => !body.p_type || r.type === body.p_type)
          return send(res, 200, { total: rows.length, rows, by_type: { INVOICE_CREATED: 1, PAYMENT_RECEIVED: 1, GOODS_RECEIVED: 1 } })
        }
        case 'erp_reconciliation':
          return send(res, 200, { generated_at: NOW, issues: 0, checks: [
            { code: 'STOCK_LEDGER', area: 'Inventory', title: 'Physical stock equals the stock ledger', rule: 'On hand = sum of posted movements.', issues: 0, samples: [] },
            { code: 'CUSTOMER_LEDGER', area: 'Finance', title: 'Customer ledger reconciles', rule: 'Opening + invoices + debit notes − credit notes − payments.', issues: 0, samples: [] },
          ] })
        case 'erp_report_v2':
        case 'erp_report':
          return send(res, 200, { report: body.p_report, from: body.p_filters?.from ?? null, to: body.p_filters?.to ?? TODAY, generated_at: NOW,
            ...(() => {
              const rows = body.p_report === 'STOCK_MOVEMENTS' ? [
                { date: TODAY, number: 'TXN-000101', type: 'RECEIPT', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', product_version: 'v1', quantity: 100, unit: 'PCS', warehouse: 'MAIN', location: 'GENERAL', reference: 'GRN-000001', reason: 'Received' },
                { date: TODAY, number: 'TXN-000102', type: 'RECEIPT', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1 Premium', product_version: 'v2', quantity: 5, unit: 'PCS', warehouse: 'MAIN', location: 'GENERAL', reference: 'GRN-000002', reason: 'Received' },
                { date: TODAY, number: 'TXN-000050', type: 'OPENING_STOCK', sku: 'MOCK-OLD', product_name: 'Old washer', product_version: 'Legacy / Unversioned', quantity: 50, unit: 'PCS', warehouse: 'MAIN', location: 'GENERAL', reference: null, reason: 'Opening' },
              ] : body.p_report === 'INVOICE_REGISTER' ? [
                { id: 'inv2', invoice_number: 'INV/26-27/0001', date: TODAY, customer: 'Acme Ltd', gstin: '27BBBBB0000B1Z5', taxable: 1900, cgst: 171, sgst: 171, igst: 0, grand_total: 2242, paid: 1121, balance: 1121, status: 'PARTIALLY_PAID', due_date: TODAY },
                { id: 'inv9', invoice_number: 'INV/26-27/0009', date: TODAY, customer: 'Beta Traders', gstin: null, taxable: 1000, cgst: 90, sgst: 90, igst: 0, grand_total: 1180, paid: 0, balance: null, status: 'CANCELLED', due_date: TODAY },
              ] : []
              const term = String(body.p_filters?.search ?? '').toLowerCase()
              const shown = term ? rows.filter((r) => Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(term))) : rows
              return { count: shown.length, rows: shown }
            })() })
        case 'sales_orders_v2_list':
        case 'sales_orders_v2_list_excl_gst':
          return send(res, 200, [{ id: 'so1', sales_order_number: 'SO-000001', order_date: TODAY, customer_id: 'cu1', customer_name: 'Acme Ltd', customer_reference: 'ACME-77',
            requested_delivery_date: null, grand_total: 118000, taxable_total: 100000, status: 'READY_FOR_DISPATCH', order_status: 'CONFIRMED', created_at: NOW, units: [] }])
        // V2 Stage 6: invoicing
        case 'invoice_dashboard':
          return send(res, 200, { from: body.p_from, to: body.p_to, today: TODAY, currency: 'INR', total_invoices: 14, created_today: 2, this_month: 9, total_value: 254380.5,
            taxable_value: 215576.7, gst_collected: 38803.8, amount_received: 120000, outstanding: 134380.5, overdue_amount: 22420, partially_paid: 3, fully_paid: 6, drafts: 2,
            proforma: 1, cancelled: 1,
            recent: [{ id: 'inv2', invoice_number: 'INV/26-27/0001', invoice_date: TODAY, customer_name: 'Acme Ltd', grand_total: 2242, balance_due: 1121, status: 'ISSUED', payment_status: 'PARTIALLY_PAID', created_at: NOW }],
            overdue: [{ id: 'inv2', invoice_number: 'INV/26-27/0001', customer_name: 'Acme Ltd', due_date: TODAY, balance_due: 22420, days_overdue: 12 }],
            monthly: [{ month: `${TODAY.slice(0, 7)}-01`, invoiced: 254380.5, received: 120000, gst: 38803.8 }],
            gst_summary: [{ gst_rate: 12, taxable: 15576.7, cgst: 934.6, sgst: 934.6, igst: 0, tax: 1869.2, lines: 3 }, { gst_rate: 18, taxable: 200000, cgst: 9000, sgst: 9000, igst: 18934.6, tax: 36934.6, lines: 9 }],
            hsn_summary: [] })
        case 'sales_invoice_v2_save':
          return send(res, 200, { invoice_id: body.p_invoice_id ?? 'inv1', status: 'DRAFT', is_proforma: Boolean(body.p_header?.is_proforma),
            proforma_number: body.p_header?.is_proforma ? 'PFI-000002' : null, grand_total: 2360, issues: [] })
        case 'sales_invoice_v2_issue':
          return send(res, 200, { invoice_id: body.p_invoice_id, invoice_number: 'INV/26-27/0003', financial_year: '2026-27', grand_total: 2360,
            warnings: body.p_convert_proforma ? [] : ['Confirmed when issuing: Shipping state differs from the place of supply.'],
            dispatched_on_posting: partialPreview ? [{ sales_order_id: 'so1', dispatched_quantity: 8, transaction_numbers: ['TXN-000090'] }] : [],
            partial_invoice: { partial: partialPreview, notified: partialPreview ? 1 : 0 } })
        case 'sales_order_invoice_lines':
          return send(res, 200, { sales_order_id: 'so1', sales_order_number: 'SO-000001', customer_id: 'cu1', customer_name: 'Acme Ltd', customer_reference: 'ACME-77',
            payment_terms: '30 days', billing_address: 'Plot 4, Mock Estate', shipping_address: null, freight_amount: 0, other_charges_amount: 0,
            lines: [{ sales_order_line_id: 'sol1', line_no: 1, product_id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', description: 'Mock Closet 1', unit: 'PCS',
              hsn_code: '6910', ordered: 10, dispatched: 2, invoiced: 4, pending: 6, unit_price: 950, discount_percent: null, gst_rate: 18 }] })
        case 'invoice_v2_record_payment': {
          const amt = Number(body.p_payment?.amount)
          return send(res, 200, { payment_id: 'pay10', receipt_number: 'RCT/26-27/0003', allocated: Math.min(amt, 1121), advance: Math.max(amt - 1121, 0), balance_due: Math.max(1121 - amt, 0),
            warnings: amt > 1121 ? [`${amt} is more than the balance; ${(amt - 1121).toFixed(2)} is kept as an advance on the customer's account.`] : [] })
        }
        case 'invoice_v2_apply_advance':
          return send(res, 200, { applied: 100, balance_due: 1021, receipt_number: 'RCT/26-27/0001', unallocated: 0 })
        case 'adjustment_note_v2_issue':
          return send(res, 200, { note_id: 'cn1', note_number: body.p_type === 'CREDIT' ? 'CN/26-27/0001' : 'DN/26-27/0001', total: 1121, balance_due: 0, note_type: body.p_type })
        case 'billing_settings_update':
          return send(res, 200, { ...BILLING_SETTINGS, ...body.p_changes })
        case 'invoice_import_preview': {
          const groups = new Map()
          for (const r of body.p_rows) { if (!groups.has(r.invoice_number)) groups.set(r.invoice_number, []); groups.get(r.invoice_number).push(r) }
          const invoices = [...groups.values()].map((rs) => {
            const bad = rs.some((r) => r.sku !== 'MOCK-WC-1')
            return { invoice_number: rs[0].invoice_number, first_row: rs[0].row_number, status: bad ? 'ERROR' : 'VALID', errors: bad ? ['1 row(s) of this invoice have errors, so the invoice is held back.'] : [],
              warnings: [], invoice_date: rs[0].invoice_date, customer_name: rs[0].customer_name, customer_gstin: null, sales_order_number: null, place_of_supply: '27', estimated_total: 1121 * rs.length,
              rows: rs.map((r) => ({ row_number: r.row_number, sku: r.sku, product_name: r.product_name, quantity: Number(r.quantity), unit: 'PCS', rate: Number(r.rate), gst_rate: 18,
                errors: r.sku === 'MOCK-WC-1' ? [] : [`Product SKU "${r.sku}" was not found. Add the product (Quick Add) and check the file again.`], warnings: [], line_value: 1121 })) }
          })
          return send(res, 200, { invoices, rows: body.p_rows.length, valid: invoices.filter((g) => g.status === 'VALID').length, warnings: 0, errors: invoices.filter((g) => g.status === 'ERROR').length,
            missing_customers: [], missing_products: invoices.filter((g) => g.status === 'ERROR').map((g) => ({ sku: g.rows.find((r) => r.errors.length).sku, name: null })) })
        }
        case 'invoice_import':
          return send(res, 200, { job_id: 'job11', created: [{ first_row: 2, invoice_id: 'inv2', invoice_number: 'OLD-1001', grand_total: 2242, rows: [2, 3] }],
            failed: [{ first_row: 4, invoice_number: 'OLD-1002', messages: ['1 row(s) of this invoice have errors, so the invoice is held back.'], rows: [4] }], created_count: 1, failed_count: 1 })
        // V2 Stage 4: simple production flow
        case 'production_dashboard':
          return send(res, 200, { from: body.p_from, to: body.p_to, today: TODAY, orders: 7, orders_completed: 3, open_orders: 4,
            produced_today: [{ unit: 'PCS', quantity: 40 }], produced_month: [{ unit: 'PCS', quantity: 640 }], finished_goods: [{ unit: 'PCS', quantity: 600 }],
            raw_materials: [{ unit: 'KG', quantity: 1500.5 }], components: [{ unit: 'PCS', quantity: 1200 }], rejected: [{ unit: 'PCS', quantity: 12 }],
            wastage: [{ unit: 'PCS', quantity: 3 }], pending: [{ unit: 'PCS', quantity: 260 }],
            shortages: [{ component_product_id: 'p3', sku: 'MOCK-CLAY', product_name: 'Mock ceramic body', unit: 'KG', needed: 500, reserved: 200, available: 100, shortage: 200, orders: 2 }],
            recent: [{ id: 'ev9', created_at: NOW, event_type: 'PRODUCTION_RECORDED', to_status: 'COMPLETED', note: null, details: { accepted: 40, rejected: 2, wastage: 0 },
              order_id: 'po1', production_order_number: 'PRD-000001', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS' }] })
        case 'production_v2_preview': {
          const qty = Number(body.p_quantity) || 0
          const noBom = body.p_product_id === 'p3'
          return send(res, 200, {
            product: { id: body.p_product_id, sku: noBom ? 'MOCK-CLAY' : 'MOCK-WC-1', product_name: noBom ? 'Mock ceramic body' : 'Mock Closet 1', product_type: 'FINISHED_GOOD', unit: noBom ? 'KG' : 'PCS', track_batches: false, track_expiry: false },
            bom: noBom ? null : { id: 'bom1', bom_code: 'BOM-000001', version: 1, output_quantity: 1, item_count: 2 }, warehouse_id: 'w1',
            lines: noBom || !qty ? [] : [
              { component_product_id: 'p3', line_no: 1, sku: 'MOCK-CLAY', product_name: 'Mock ceramic body', product_type: 'RAW_MATERIAL', source_type: 'PURCHASED', unit: 'KG', quantity_per_unit: 2.5, wastage_percentage: 0, base_quantity: qty * 2.5, required: qty * 2.5, available: 20, reserved: 0, shortage: Math.max(qty * 2.5 - 20, 0) },
              { component_product_id: 'p4', line_no: 2, sku: 'MOCK-GLZ', product_name: 'Mock glaze', product_type: 'RAW_MATERIAL', source_type: 'PURCHASED', unit: 'KG', quantity_per_unit: 0.2, wastage_percentage: 10, base_quantity: qty * 0.2, required: qty * 0.22, available: 50, reserved: 0, shortage: 0 },
            ],
            warnings: noBom ? ['MOCK-CLAY has no active BOM. Add its components below; they become BOM version 1.'] : qty * 2.5 > 20 ? [`MOCK-CLAY: short by ${qty * 2.5 - 20} KG. Purchase ${qty * 2.5 - 20} KG (only the stock available was reserved).`] : [],
          })
        }
        case 'production_order_v2_save':
          return send(res, 200, { order_id: 'po1', production_order_number: 'PRD-000010', status: 'APPROVED', bom_code: 'BOM-000001', bom_version: 1, requirements: [], completion: null,
            warnings: ['MOCK-CLAY: short by 5 KG. Purchase 5 KG (only the stock available was reserved).'] })
        case 'production_order_v2_requirements':
          return send(res, 200, [
            { order_material_id: 'pm1', component_product_id: 'p3', line_no: 1, sku: 'MOCK-CLAY', product_name: 'Mock ceramic body', product_type: 'RAW_MATERIAL', source_type: 'PURCHASED', unit: 'KG', quantity_per_unit: 2.5, wastage_percentage: 0, base_quantity: 25, required: 25, issued: 25, reserved: 0, available: 30, shortage: 0 },
            { order_material_id: 'pm2', component_product_id: 'p4', line_no: 2, sku: 'MOCK-GLZ', product_name: 'Mock glaze', product_type: 'RAW_MATERIAL', source_type: 'PURCHASED', unit: 'KG', quantity_per_unit: 0.2, wastage_percentage: 10, base_quantity: 2, required: 2.2, issued: 0, reserved: 2.2, available: 10, shortage: 0 },
          ])
        case 'production_order_v2_complete':
          return send(res, 200, { order_id: body.p_order_id, production_order_number: 'PRD-000001', receipt_number: 'FGR-000010', accepted: 9, rejected: 1, wastage: 0, unit: 'PCS', unit_cost: 812.5,
            transaction_numbers: ['TXN-000040', 'TXN-000041'], warnings: ['MOCK-GLZ: consumed 2.5 KG, standard for this output is 2.2 (0.3 extra recorded as material wastage).'] })
        case 'production_order_v2_correct':
          return send(res, 200, { status: 'COMPLETED', reversal_numbers: ['TXN-000050'], completion: { receipt_number: 'FGR-000011', accepted: 10 }, warnings: [] })
        case 'production_bom_add_components':
          return send(res, 200, { bom_id: 'bom9', bom_code: 'BOM-000009', version: 1, components: 1, added: 1, replaced_version: null })
        case 'production_import_preview':
          return send(res, 200, { warehouse_id: 'w1', total: body.p_rows.length,
            rows: body.p_rows.map((r) => {
              const bad = r.sku !== 'MOCK-WC-1'
              return { row_number: r.row_number, status: bad ? 'ERROR' : 'VALID', errors: bad ? [`SKU "${r.sku}" was not found in the Product Master.`] : [], warnings: [],
                product_id: bad ? null : 'p1', sku: r.sku, product_name: bad ? null : 'Mock Closet 1', unit: 'PCS', bom_code: bad ? null : 'BOM-000001', bom_version: bad ? null : 1,
                production_date: r.production_date, planned_quantity: Number(r.planned_quantity), actual_quantity: r.actual_quantity ? Number(r.actual_quantity) : null,
                rejected_quantity: Number(r.rejected_quantity || 0), remarks: r.remarks, complete: Boolean(r.actual_quantity), materials: bad ? [] : [{ sku: 'MOCK-CLAY', unit: 'KG', required: 25, available: 30, shortage: 0 }] }
            }),
            valid: body.p_rows.filter((r) => r.sku === 'MOCK-WC-1').length, warnings: 0, errors: body.p_rows.filter((r) => r.sku !== 'MOCK-WC-1').length,
            to_complete: body.p_rows.filter((r) => r.sku === 'MOCK-WC-1' && r.actual_quantity).length })
        case 'production_import':
          return send(res, 200, { job_id: 'job9',
            created: body.p_rows.filter((r) => r.sku === 'MOCK-WC-1').map((r, i) => ({ row_number: r.row_number, sku: r.sku, order_id: 'po1', production_order_number: `PRD-00002${i}`, status: r.actual_quantity ? 'COMPLETED' : 'APPROVED', warnings: [] })),
            failed: body.p_rows.filter((r) => r.sku !== 'MOCK-WC-1').map((r) => ({ row_number: r.row_number, sku: r.sku, messages: [`SKU "${r.sku}" was not found in the Product Master.`] })),
            created_count: body.p_rows.filter((r) => r.sku === 'MOCK-WC-1').length, failed_count: body.p_rows.filter((r) => r.sku !== 'MOCK-WC-1').length })
        case 'production_order_action':
          return send(res, 200, { status: 'IN_PROGRESS', released_reservation_quantity: 0, discrepancies: [] })
        case 'production_order_requirements':
          return send(res, 200, ORDER_REQUIREMENTS)
        case 'production_issue_materials':
          return send(res, 200, { transaction_numbers: ['TXN-000031'] })
        case 'production_receive_output':
          return send(res, 200, { receipt_id: 'fr9', receipt_number: 'FGR-000009', good_transaction_number: 'TXN-000032', rejected_transaction_number: null })
        case 'outsourcing_receive_goods':
          return send(res, 200, { receipt_id: 'or9', receipt_number: 'OGR-000009', accepted_transaction_number: 'TXN-000033', rejected_transaction_number: null })
        case 'outsourcing_move_materials':
          return send(res, 200, { transaction_numbers: ['TXN-000034'], status: 'MATERIALS_DISPATCHED' })
        case 'production_report':
          return send(res, 200, body.p_report === 'COST_SUMMARY'
            ? [{ order_type: 'PRODUCTION', order_number: 'PRD-000001', sku: 'MOCK-WC-1', unit: 'PCS', good_quantity: 4, material_cost: null, outsourcing_cost: null, total_cost: null,
                cost_per_good_unit: null, standard_estimate_for_output: null, variance: null, cost_status: 'COST_DATA_INCOMPLETE', notes: '1 of 2 material issues are from lots with unknown cost' }]
            : [{ sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', production_order_number: 'PRD-000001', status: 'IN_PROGRESS' }])
        case 'customer_po_customer_options':
          return send(res, 200, [{ customer_key: 'C:cu1', customer_name: 'Acme Ltd', customer_id: 'cu1' }])
        case 'customer_po_dashboard':
          return send(res, 200, PO_DASHBOARD)
        case 'customer_po_preview':
          return send(res, 200, {
            customer_id: body.p_header.customer_id, customer_name: 'Acme Ltd', duplicate_po: null, duplicate_file: null,
            lines: body.p_lines.map((l) => {
              const ok = String(l.sku ?? '').toUpperCase() === 'MOCK-WC-1'
              return { source_row_number: l.source_row_number, status: ok ? 'MATCHED' : 'UNMATCHED', reason: null, method: ok ? 'SKU' : null,
                note: ok ? 'Exact internal SKU' : 'No product with this code.', product_id: ok ? 'p1' : null, sku: ok ? 'MOCK-WC-1' : null,
                product_name: ok ? 'Mock Closet 1' : null, base_unit: ok ? 'PCS' : null, duplicate_of_row: null, candidates: [],
                in_house_available: ok ? 90 : null, outsourced_available: ok ? 40 : null, unknown_on_hand: ok ? 0 : null,
                available_for_line: ok ? Math.min(130, l.quantity) : null, availability_status: ok ? 'FULLY_AVAILABLE' : 'PRODUCT_UNMATCHED' }
            }),
          })
        case 'customer_po_import':
          return send(res, 200, { ok: true, po_id: 'cpo1', po_reference: 'CPO-000009', revision: 1, status: 'PRODUCT_MATCHING_REQUIRED', lines: body.p_lines.length,
            matched: 1, unmatched: body.p_lines.length - 1, ambiguous: 0, invalid: 0, duplicate_review: 0 })
        case 'customer_po_line_action':
          return send(res, 200, { line_status: 'MATCHED', po_status: 'READY_FOR_ALLOCATION' })
        case 'customer_po_analysis':
          return send(res, 200, { availability_status: 'FULLY_AVAILABLE', review_warnings: 0, calculated_at: NOW, lines: [PO_ANALYSIS_LINE],
            units: [{ unit: 'PCS', ordered: 5, dispatched: 0, allocated: 0, available_for_lines: 5, shortage_before: 0, shortage_after: 5 }] })
        case 'customer_po_line_stock':
          return send(res, 200, [
            { balance_id: 'b1', batch_id: 'lot-IN_HOUSE', batch_number: null, source_type: 'IN_HOUSE', warehouse_id: 'w1', warehouse_code: 'MAIN', location_id: 'l1', location_code: 'GENERAL',
              stock_usage: 'STORAGE', expiry_date: null, on_hand: 100, reserved: 10, available: 90, eligible: true, ineligible_reason: null, reserved_for_line: 0 },
            { balance_id: 'b9', batch_id: 'lot-x', batch_number: null, source_type: 'IN_HOUSE', warehouse_id: 'w1', warehouse_code: 'MAIN', location_id: 'l4', location_code: 'REJECT',
              stock_usage: 'REJECTED', expiry_date: null, on_hand: 3, reserved: 0, available: 3, eligible: false, ineligible_reason: 'Rejected goods (non-saleable)', reserved_for_line: 0 },
          ])
        case 'customer_po_propose':
          return send(res, 200, [{ line_id: 'cl1', balance_id: 'b1', quantity: 5, batch_id: 'lot-IN_HOUSE', batch_number: null, source_type: body.p_strategy === 'OUTSOURCED_FIRST' ? 'OUTSOURCED' : 'IN_HOUSE',
            warehouse_id: 'w1', warehouse_code: 'MAIN', location_id: 'l1', location_code: 'GENERAL', expiry_date: null }])
        case 'customer_po_allocate':
          return send(res, 200, { reservations: [{ reservation_number: 'RES-000041', line_id: 'cl1', quantity: 5, source_type: 'IN_HOUSE', warehouse_code: 'MAIN', location_code: 'GENERAL', batch_number: null }],
            shortages: [], status: 'FULLY_ALLOCATED' })
        case 'customer_po_shortages':
          return send(res, 200, [{ po_id: 'cpo1', po_reference: 'CPO-000001', customer_name: 'Acme Ltd', customer_key: 'C:cu1', customer_po_number: 'ACME-77', revision: 1, po_date: TODAY,
            required_delivery_date: TODAY, po_status: 'READY_FOR_ALLOCATION', warehouse_code: null, line_id: 'cl1', line_no: 1, product_id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1',
            category_name: null, unit: 'PCS', quantity_ordered: 5, quantity_dispatched: 0, allocated: 0, available: 5, shortage: 5, shortage_before: 0, in_house_available: 90,
            outsourced_available: 40, other_warehouse_available: 0, unknown_on_hand: 0, shortage_status: 'OPEN', priority: 'NORMAL', owner: null, last_note: null,
            suggested_actions: ['Allocate the eligible stock that is available now'] }])
        case 'customer_po_assignable_users':
          return send(res, 200, [{ user_id: MANAGER_ID, display_name: 'Smoke Tester' }])
        case 'customer_po_revision_diff':
          return send(res, 200, { previous_revision: null, changes: [] })
        case 'sales_overview':
          return send(res, 200, SALES_OVERVIEW)
        case 'sales_order_po_candidates':
          return send(res, 200, [{ po_id: 'cpo1', po_reference: 'CPO-000001', customer_po_number: 'ACME-77', revision: 1, customer_name: 'Acme Ltd', po_date: TODAY,
            required_delivery_date: TODAY, status: 'READY_FOR_ALLOCATION', sales_orders: null, convertible_quantity: 5 }])
        case 'sales_order_po_preview':
          return send(res, 200, {
            po: { po_id: 'cpo1', po_reference: 'CPO-000001', customer_po_number: 'ACME-77', revision: 1, customer_id: 'cu1', customer_name: 'Acme Ltd', customer_code: 'ACME',
              po_date: TODAY, required_delivery_date: TODAY, currency: 'INR', status: 'FULLY_ALLOCATED', fulfilment_warehouse_id: null, source_filename: 'acme-77.xlsx', is_current: true },
            existing_sales_orders: [], blockers: [],
            lines: [{ po_line_id: 'cl1', line_no: 1, product_id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', product_status: 'ACTIVE', base_unit: 'PCS', unit: 'PCS',
              line_status: 'MATCHED', quantity_ordered: 5, dispatched_by_po: 0, converted: 0, convertible: 5, po_reserved: 5, unit_price: 950, currency: 'INR',
              reservations: [{ reservation_number: 'RES-000041', remaining: 5, warehouse_code: 'MAIN', location_code: 'GENERAL', batch_number: null, source_type: 'IN_HOUSE' }] }],
          })
        case 'sales_order_create_from_po':
          return send(res, 200, { sales_order_id: 'so1', sales_order_number: 'SO-000009', status: 'PENDING_CONFIRMATION', lines: (body.p_lines ?? []).length, transferred_reserved: 5 })
        case 'fulfilment_policy':
          return send(res, 200, { dispatch_required_fields: ['vehicle_number'] })
        case 'fulfilment_pick':
          return send(res, 200, { status: body.p_complete ? 'PICKED' : 'PICKING', picked: (body.p_lines ?? []).reduce((s, l) => s + Number(l.quantity_picked), 0) })
        case 'fulfilment_dispatch':
          return send(res, 200, { transaction_numbers: ['TXN-000050'], dispatched_quantity: 1, fulfilment_status: 'DISPATCHED', order_status: 'PARTIALLY_FULFILLED' })
        case 'fulfilment_record_delivery':
          return send(res, 200, { status: 'IN_TRANSIT', delivered: [] })
        case 'sales_order_cancel_preview':
          return send(res, 200, {
            sales_order_number: 'SO-000002', order_status: 'PENDING_CONFIRMATION', can_cancel: true, blocked_reason: null, has_dispatches: false,
            lines: [{ line_no: 1, sku: 'MOCK-WC-1', unit: 'PCS', ordered: 1, cancelled: 0, dispatched: 0, delivered: 0, reserved: 0, planned: 0, will_cancel: 1 }],
            fulfilments: [], reservations: [], movements: [],
          })
        case 'sales_order_cancel':
          return send(res, 200, { status: 'CANCELLED', released_quantity: 0, fulfilments_cancelled: 0, dispatched_kept: 0 })
        case 'customer_return_review':
          return send(res, 200, { status: body.p_decision === 'AUTHORIZE' ? 'AUTHORIZED' : 'REJECTED' })
        case 'fulfilment_report':
          return send(res, 200, body.p_report === 'DISPATCH_REGISTER'
            ? [{ fulfilment_number: 'FUL-000003', dispatched_at: NOW, sales_order_number: 'SO-000001', customer: 'Acme Ltd', customer_po_number: 'ACME-77', warehouse_code: 'MAIN',
                carrier_name: 'Mock Freight', transport_mode: 'ROAD', vehicle_number: 'MH12AB1234', lr_number: null, tracking_number: 'TRK-9', eway_bill_number: null,
                fulfilment_status: 'DISPATCHED', units: 'PCS', dispatched: 2, transaction_numbers: 'TXN-000040', expected_delivery_date: TODAY }]
            : [{ sales_order_number: 'SO-000001', order_date: TODAY, customer: 'Acme Ltd', order_status: 'IN_FULFILMENT', unit: 'PCS', ordered: 5, dispatched: 2, remaining: 3 }])
        case 'production_trace_batch':
          return send(res, 200, {
            batch: { batch_id: 'lot-g1', sku: 'MOCK-GLZ', product_name: 'Mock glaze', unit: 'KG', batch_number: 'G-1', is_system_lot: false, source_type: 'OUTSOURCED',
              manufacturing_date: null, expiry_date: null, created_at: NOW, on_hand: 20 },
            completeness: { inflow_quantity: 20, linked_inflow_quantity: 0, unlinked_inflow_quantity: 20, pooled_lot: false,
              warnings: ['20 of 20 received into this lot came from opening stock, purchases, returns or adjustments, which have no production or outsourcing link.'] },
            produced_by: [],
            used_in: [{ kind: 'PRODUCTION', order_id: 'po1', order_number: 'PRD-000001', date: TODAY, quantity: 2.2, unit: 'KG', order_status: 'IN_PROGRESS',
              outputs: [{ batch_id: 'lot-IN_HOUSE', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', batch_number: null, good: 4, receipt_number: 'FGR-000001', date: TODAY }] }],
            history: [{ transaction_number: 'TXN-000002', transaction_type: 'RECEIPT', direction: 1, quantity: 20, unit: 'KG', transaction_date: NOW, warehouse_code: 'MAIN',
              location_code: 'GENERAL', stock_usage: 'STORAGE', reference_type: null, reference_number: null, reason: 'Goods received' }],
          })
        case 'billing_settings_get':
          return send(res, 200, BILLING_SETTINGS)
        case 'gst_state_codes':
          return send(res, 200, [{ code: '27', name: 'Maharashtra' }, { code: '29', name: 'Karnataka' }])
        case 'purchase_order_dashboard':
          return send(res, 200, { total: 3, by_status: { DRAFT: 1, PENDING_APPROVAL: 1, SENT: 1 }, open: 1, overdue: 0, period_value: 10620, period_orders: 1,
            outstanding_receipt_value: 8496, generated_at: NOW })
        case 'ledger_sync_parties':
          return send(res, 200, { customers_added: 0, suppliers_added: 0 })
        case 'ledger_parties':
        case 'ledger_parties_excl_gst': {
          const rows = LEDGER_PARTIES.filter((p) => !body.p_party_id || p.party_id === body.p_party_id)
          return send(res, 200, fn === 'ledger_parties' ? rows : rows.map((r) => ({ ...r,
            receivable_excl_gst: Number(r.receivable) > 0 ? null : 0, receivable_gst_status: Number(r.receivable) > 0 ? 'REVIEW' : 'SETTLED',
            payable_excl_gst: Number(r.payable) > 0 ? Math.round(Number(r.payable) / 1.18 * 100) / 100 : 0, payable_gst_status: Number(r.payable) > 0 ? 'EXACT' : 'SETTLED' })))
        }
        case 'party_transactions':
          return send(res, 200, { customer_visible: true, supplier_visible: true, entries: LEDGER_ENTRIES })
        case 'party_find_duplicates':
          return send(res, 200, [])
        case 'party_save': {
          const name = String(body.p_party?.party_name ?? '')
          if (/shree clay/i.test(name) && !body.p_confirm_duplicates) {
            return send(res, 200, { ok: false, duplicates: [{ party_id: 'pty-sup1', party_code: 'PTY-000002', party_name: 'Shree Clay', party_type: 'SUPPLIER', matched_on: ['name'], blocking: false }] })
          }
          const type = body.p_party?.party_type
          const isSup = type !== 'CUSTOMER'
          const isCus = type === 'CUSTOMER' || type === 'BOTH'
          if (isSup && !tables.suppliers.some((s) => s.id === 'sup-new')) tables.suppliers.push(supplierRow('sup-new', 'SUP-000003', { legal_name: name, state_code: body.p_party?.state_code ?? null }))
          if (isCus && !tables.customers.some((c) => c.id === 'cu-new')) {
            const pp = body.p_party ?? {}
            tables.customers.push({ id: 'cu-new', company_id: COMPANY_ID, customer_code: 'CUS-000009', customer_name: name, contact_email: pp.email ?? null, status: 'ACTIVE', notes: null,
              gstin: pp.gstin ?? null, billing_address: pp.billing_address ?? null, shipping_address: pp.shipping_address ?? null, billing_state_code: pp.state_code ?? null,
              payment_terms_days: pp.credit_period_days ?? null, created_at: NOW, updated_at: NOW })
          }
          return send(res, 200, { ok: true, party_id: 'pty-new', party_code: 'PTY-000009', party_type: type,
            customer_id: isCus ? 'cu-new' : null, customer_code: isCus ? 'CUS-000009' : null, supplier_id: isSup ? 'sup-new' : null, supplier_code: isSup ? 'SUP-000003' : null })
        }
        case 'purchase_supplier_options':
          return send(res, 200, tables.suppliers.filter((s) => s.status === 'ACTIVE').map((s) => ({ ...s, state_code: s.gstin ? s.gstin.slice(0, 2) : s.state_code })))
        case 'purchase_order_validate':
          return send(res, 200, [])
        case 'purchase_order_import_preview':
          return send(res, 200, { previous_imports: [], groups: body.p_groups.map((g) => {
            const known = g.header.supplier_code.toUpperCase() === 'SUP-000001'
            const rows = g.rows.map((r) => r.row_number)
            return { reference: g.reference, supplier_code: known ? 'SUP-000001' : null, supplier_name: known ? 'Shree Clay Works Pvt Ltd' : null, warehouse_code: 'MAIN', rows,
              ok: known, errors: known ? [] : [{ row: rows[0], message: `Supplier code "${g.header.supplier_code}" was not found in your company. Add the supplier under Suppliers first; imports never create suppliers.` }],
              warnings: [], tax_treatment: known ? 'INTRA_STATE' : null,
              lines: known ? g.rows.map((r) => ({ row: r.row_number, sku: r.sku, unit: 'PCS', gst_rate: 18, gross: 1000, discount: 0, taxable: 1000, cgst: 90, sgst: 90, igst: 0, total: 1180 })) : null,
              totals: known ? { gross: 1000 * rows.length, discount: 0, taxable: 1000 * rows.length, cgst: 90 * rows.length, sgst: 90 * rows.length, igst: 0, round_off: 0, grand: 1180 * rows.length } : null }
          }) })
        case 'purchase_order_import':
          return send(res, 200, { job_id: 'job-po-1', created: body.p_groups.map((g, i) => ({ reference: g.reference, po_id: 'po1', po_number: `PO-00001${i}`, supplier_code: 'SUP-000001',
            lines: g.rows.length, grand_total: 1180 * g.rows.length, tax_treatment: 'INTRA_STATE' })), failed: [], created_count: body.p_groups.length, failed_count: 0,
            imported_rows: body.p_groups.reduce((s, g) => s + g.rows.length, 0), failed_rows: body.p_rejected.length })
        case 'purchase_order_save_refs':
        case 'purchase_order_save':
          return send(res, 200, { po_id: 'po1', po_number: 'PO-000001', status: 'DRAFT', updated_at: NOW, grand_total: 10620 })
        case 'purchase_order_action':
          return send(res, 200, { po_id: body.p_po_id, status: body.p_action === 'APPROVE' ? 'APPROVED' : 'DRAFT', updated_at: NOW })
        case 'purchase_order_open':
          return send(res, 200, { po_id: body.p_po_id, status: 'APPROVED', updated_at: NOW })
        case 'purchase_receipt_post_refs':
        case 'purchase_receipt_post':
          return send(res, 200, { receipt_id: 'gr2', receipt_number: 'GRN-000002', po_status: 'PARTIALLY_RECEIVED', transaction_numbers: ['TXN-000091'],
            ...(GRN_COST_CONFIRMED ? { actual_cost_supported: true } : {}),
            hsn_updates: (body.p_lines ?? []).filter((l) => l.hsn_code).map((l) => ({ product_id: 'p1', sku: 'MOCK-WC-1', previous_hsn: '6910', new_hsn: l.hsn_code })) })
        case 'goods_receipt_direct_post_refs':
        case 'goods_receipt_direct_post':
          return send(res, 200, { receipt_id: 'gr9', receipt_number: 'GRN-000009', transaction_numbers: ['TXN-000095'], unlinked: true,
            warnings: ['This receipt is not linked to a purchase order.', 'No supplier was recorded for this receipt.'] })
        case 'goods_receipt_correct_refs':
        case 'goods_receipt_correct':
          return send(res, 200, { receipt_id: 'gr10', receipt_number: 'GRN-000010', transaction_numbers: ['TXN-000097'], corrects_receipt_number: 'GRN-000001', reversal_numbers: ['TXN-000096'],
            ...(GRN_COST_CONFIRMED ? { actual_cost_supported: true } : {}) })
        case 'goods_receipt_reverse':
          return send(res, 200, { reversal_numbers: ['TXN-000098'], po_status: null })
        case 'purchase_document_refs_set':
          return send(res, 200, { supplier_invoice_number: body.p_refs?.supplier_invoice_number ?? null, supplier_challan_number: body.p_refs?.supplier_challan_number ?? null, changed: true })
        case 'inventory_stock_position': {
          const pos = (over) => ({ product_id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', category_id: 'c2', category_name: 'Water Closets / Toilets',
            product_type: 'FINISHED_GOOD', unit: 'PCS', product_status: 'ACTIVE', on_hand: 140, reserved: 10, available: 130, pending_po_quantity: 8, open_po_count: 1,
            pending_production_quantity: 0, expected_incoming_quantity: 8, bom_required_quantity: 0, bom_shortage_quantity: 0, ledger_on_hand: 140, discrepancy: false,
            stock_status: 'HEALTHY', low_stock: false, reorder_level: 10, reorder_level_days: null, lead_time_days: null, last_movement_at: NOW, ...over })
          return send(res, 200, { warehouse_id: body.p_filters?.warehouse_id ?? null, as_of: NOW, rows: [
            pos({}),
            pos({ product_id: 'p3', sku: 'MOCK-CLAY', product_name: 'Mock ceramic body', product_type: 'RAW_MATERIAL', unit: 'KG', on_hand: 40, reserved: 7.5, available: 32.5,
              pending_po_quantity: 0, open_po_count: 0, expected_incoming_quantity: 0, bom_required_quantity: 55, bom_shortage_quantity: 22.5, ledger_on_hand: 40,
              stock_status: 'LOW_STOCK', low_stock: true }),
            pos({ product_id: 'p4', sku: 'MOCK-GLZ', product_name: 'Mock glaze', product_type: 'RAW_MATERIAL', unit: 'KG', on_hand: 12, reserved: 0, available: 12,
              pending_po_quantity: 0, open_po_count: 0, expected_incoming_quantity: 0, ledger_on_hand: 11, discrepancy: true }),
            ...Array.from({ length: STOCK_POSITION_EXTRA }, (_, i) => pos({ product_id: `px${i + 1}`, sku: `MOCK-X${String(i + 1).padStart(2, '0')}`, product_name: `Extra item ${i + 1}`,
              on_hand: i + 1, reserved: 0, available: i + 1, pending_po_quantity: 0, open_po_count: 0, expected_incoming_quantity: 0, ledger_on_hand: i + 1 })),
          ] })
        }
        case 'inventory_stock_position_detail':
          return send(res, 200, { product: { id: body.p_product_id, sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS' },
            locations: [{ warehouse_code: 'MAIN', location_code: 'GENERAL', stock_usage: 'STORAGE', batch_number: null, source_type: 'IN_HOUSE', on_hand: 140, reserved: 10, available: 130, ledger_on_hand: 140 }],
            purchase_orders: [{ id: 'po3', po_number: 'PO-000003', status: 'SENT', supplier: 'Shree Clay Works Pvt Ltd', expected: TODAY, ordered: 10, accepted: 2, pending: 8 }],
            goods_receipts: [{ id: 'gr1', receipt_number: 'GRN-000001', date: TODAY, status: 'POSTED', po_number: 'PO-000003', accepted: 2, rejected: 0, supplier_invoice_number: 'SINV-778', supplier_challan_number: 'DC-554' }],
            production_orders: [{ id: 'po1', production_order_number: 'PRD-000001', status: 'IN_PROGRESS', role: 'OUTPUT', planned: 10, completed: 4, pending: 6 }],
            bom_components: [{ sku: 'MOCK-CLAY', product_name: 'Mock ceramic body', unit: 'KG', quantity_per_output: 5, output_quantity: 1, wastage_percentage: 10, bom_code: 'BOM-000001', version: 1 }],
            used_in: [], can_see_purchases: true, can_see_production: true })
        case 'inventory_reconciliation':
          return send(res, 200, { as_of: NOW, issues: 1, checked_lots: 4, checked_movements: 12, rows: [{ product_id: 'p4', sku: 'MOCK-GLZ', product_name: 'Mock glaze', unit: 'KG',
            warehouse_code: 'MAIN', location_code: 'GENERAL', batch_number: 'GLZ-01', on_hand: 12, ledger_on_hand: 11, difference: 1, reserved: 0, active_reservations: 0,
            problems: ['BALANCE_DIFFERS_FROM_LEDGER'] }] })
        case 'inventory_reorder_plan':
          return send(res, 200, REORDER_PLAN(body))
        case 'purchase_order_update_details':
          return send(res, 200, { po_id: body.p_po_id, updated_at: NOW })
        case 'supplier_activity':
          return send(res, 200, [
            { id: 'sa2', action: 'supplier.updated', event_timestamp: NOW, actor_name: 'Smoke Tester', metadata: { supplier_code: 'SUP-000001', changed_fields: ['contact_person', 'phone'] } },
            { id: 'sa1', action: 'supplier.created', event_timestamp: NOW, actor_name: 'Smoke Tester', metadata: { supplier_code: 'SUP-000001' } },
          ])
        case 'billing_overview':
          return send(res, 200, BILLING_OVERVIEW)
        case 'sales_invoice_create_draft':
          return send(res, 200, { invoice_id: 'inv1', lines: (body.p_lines ?? []).length })
        case 'sales_invoice_validate':
          return send(res, 200, [])
        case 'invoice_partial_preview':
          return send(res, 200, { invoice_id: body.p_invoice_id, partial: partialPreview, lines: [{ sales_order_id: 'so1', sales_order_number: 'SO-000001', line_id: 'sol1', sku: 'MOCK-WC-1',
            product_name: 'Mock Closet 1', unit: 'PCS', ordered: 10, previously_invoiced: 0, this_invoice: partialPreview ? 8 : 10, remaining: partialPreview ? 2 : 0 }] })
        case 'sales_invoice_tracking': {
          const l = trackingLine()
          const lines = body.p_filters?.pending_only === false || l.pending > 0 ? [l] : []
          return send(res, 200, { lines, checked_at: NOW,
            totals: lines.length ? [{ unit: 'PCS', ordered: 10, invoiced: 8, pending: l.pending, released: l.released }] : [],
            partial_invoices: [{ invoice_id: 'inv2', invoice_number: 'INV/26-27/0001', invoice_date: '2026-11-01', customer: 'Acme Ltd', sales_orders: 'SO-000001',
              posted_by: 'Smoke Tester', posted_at: NOW, lines: [{ sales_order_number: 'SO-000001', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', ordered: 10, previously_invoiced: 0, this_invoice: 8, remaining: 2 }] }],
            releases: pendingReleased ? [{ sales_order_id: 'so1', sales_order_number: 'SO-000001', customer: 'Acme Ltd', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS',
              quantity: 2, ordered: 10, invoiced: 8, invoice_numbers: ['INV/26-27/0001'], reason: 'Customer no longer needs them', released_by: 'Smoke Tester', released_at: NOW }] : [] })
        }
        case 'sales_order_line_release_pending':
          if (!has('sales_orders.cancel')) return send(res, 403, { code: '42501', message: 'You are not allowed to perform this action (requires sales_orders.cancel).' })
          pendingReleased = true
          return send(res, 200, { line_id: body.p_line_id, released: Number(body.p_quantity), pending: 0, status: 'CLOSED', reservation_released: 2 })
        case 'product_group_head_options':
          return send(res, 200, { configured: ['Sanitaryware', 'Faucets'], in_use: ['Wellness'] })
        case 'invoice_dispatch_status': {
          const goods = { line_no: 1, line_type: 'PRODUCT', product_id: 'p1', sku: 'MOCK-WC-1', product_name: 'Mock Closet 1', unit: 'PCS', applies: true, required: 10,
            dispatched: dispatchBlocked ? 4 : 10, remaining: dispatchBlocked ? 6 : 0, status: dispatchBlocked ? 'PARTIALLY_DISPATCHED' : 'FULLY_DISPATCHED', reason: null,
            sales_order_id: 'so1', sales_order_number: 'SO-000001' }
          const freight = { line_no: 2, line_type: 'CHARGE', product_id: null, sku: null, product_name: 'Freight', unit: null, applies: false, required: 1, dispatched: null,
            remaining: 0, status: 'NOT_APPLICABLE', reason: 'Charge / service line', sales_order_id: null, sales_order_number: null }
          return send(res, 200, { invoice_id: body.p_invoice_id, invoice_status: 'DRAFT', sales_order_id: 'so1', lines: [goods, freight], stock_lines: 1,
            outstanding_lines: dispatchBlocked ? 1 : 0, ready: !dispatchBlocked, checked_at: NOW })
        }
        case 'sales_invoice_issue':
          return send(res, 200, { invoice_id: body.p_invoice_id, invoice_number: 'INV/26-27/0002', financial_year: '2026-27', grand_total: 2242 })
        case 'customer_payment_record':
          return send(res, 200, { payment_id: 'pay9', receipt_number: 'RCT/26-27/0002', allocations: (body.p_allocations ?? []).length, unallocated: 0 })
        case 'billing_receivables':
          return send(res, 200, [RECEIVABLE])
        case 'billing_customer_statement':
          return send(res, 200, {
            customer: { id: 'cu1', customer_code: 'ACME', name: 'Acme Ltd', billing_address: 'Plot 4, Mock Estate', gstin: '27BBBBB0000B1Z5' },
            company: { legal_name: 'Test Co', legal_address: 'Mock Road, Pune', gstin: '27AAAAA0000A1Z5' }, from: body.p_from, to: body.p_to, opening_balance: 0, closing_balance: 1021,
            unallocated_receipts: 100, generated_at: NOW,
            entries: [{ date: TODAY, document: 'INV/26-27/0001', description: 'Invoice · SO-000001', debit: 2242, credit: 0, balance: 2242 },
              { date: TODAY, document: 'RCT/26-27/0001', description: 'Payment received (bank transfer, ref UTR123)', debit: 0, credit: 1221, balance: 1021 }],
          })
        case 'billing_report':
          return send(res, 200, body.p_report === 'INVOICES'
            ? [{ invoice_number: 'INV/26-27/0001', invoice_date: TODAY, customer: 'Acme Ltd', customer_gstin: '27BBBBB0000B1Z5', place_of_supply: '27', tax_treatment: 'INTRA_STATE',
                taxable_subtotal: 1900, cgst_total: 171, sgst_total: 171, igst_total: 0, round_off: 0, grand_total: 2242, paid: 1121, balance_due: 1121, display_status: 'PARTIALLY_PAID' }]
            : body.p_report === 'HSN_SUMMARY'
              ? [{ document_type: 'INVOICES', hsn_sac: '6910', unit: 'PCS', gst_rate: 18, quantity: 2, taxable_value: 1900, cgst: 171, sgst: 171, igst: 0, total: 2242 }]
              : [])
        // --- Phase 10 ---
        case 'approval_inbox':
          return send(res, 200, {
            requests: body.p_scope === 'MINE' ? [APPROVAL_REQUEST('ar2', 'APPROVED', { reference: 'ADJ-000002', document_id: 'a2', mine: true, requested_by: MANAGER_ID, requested_by_name: 'Smoke Tester',
              decided_at: NOW, decisions: [{ stage: 1, decision: 'APPROVE', comment: null, decided_at: NOW, approver: 'Admin Tester' }] })]
              : [APPROVAL_REQUEST('ar1', 'PENDING_APPROVAL', { can_decide: true })],
            module_items: [{ document_type: 'BOM', reference: 'BOM-000002', link: '/production/boms/bom2', submitted_at: NOW, mine: true, summary: 'Version 2 of MOCK-WC-1' }],
            generated_at: NOW,
          })
        case 'approval_decide':
          return send(res, 200, { status: body.p_decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', stage: 1 })
        case 'approval_document_search':
          return send(res, 200, [{ id: 'inv1', reference: 'DRAFT-0001', detail: 'Acme Ltd · ₹2,242.00' }])
        case 'approval_request_submit':
          return send(res, 200, { status: 'PENDING_APPROVAL', request_id: 'ar9', reference: 'DRAFT-0001' })
        case 'approval_workflow_save':
          return send(res, 200, { workflow_id: 'wf1', version: 3 })
        case 'approval_workflow_set_active':
          return send(res, 200, { is_active: body.p_active })
        case 'barcode_lookup':
          return send(res, 200, { code: body.p_code, internal_qr: String(body.p_code).includes('P-'), matches: barcodeLookup(body.p_code) })
        case 'product_assign_barcode':
          return send(res, 200, { product_id: body.p_product_id, barcode: body.p_barcode, changed: true })
        case 'document_upload_rules':
          return send(res, 200, { max_bytes: 10 * 1024 * 1024, extensions: ['pdf', 'png', 'jpg'] })
        case 'document_entity_search':
          return send(res, 200, [{ id: 'p1', reference: 'MOCK-WC-1 — Mock Closet 1' }])
        case 'user_activity_list':
          return send(res, 200, { auth_sign_in_available: true, generated_at: NOW, users: [
            { user_id: MANAGER_ID, name: 'Smoke Tester', email: 'manager@test.invalid', is_active: true, created_at: NOW, roles: ['INVENTORY_MANAGER'], last_activity_at: NOW,
              last_sign_in_event_at: NOW, auth_last_sign_in_at: NOW, actions_30d: 42, denied_30d: 0 },
            { user_id: VIEWER_ID, name: 'Viewer Tester', email: 'viewer@test.invalid', is_active: true, created_at: NOW, roles: ['MANAGEMENT_VIEWER'], last_activity_at: null,
              last_sign_in_event_at: null, auth_last_sign_in_at: null, actions_30d: 0, denied_30d: 3 },
          ] })
        case 'user_activity_detail':
          return send(res, 200, { actions: [{ at: NOW, action: 'inventory.receipt', resource_type: 'inventory_transaction', resource_id: null }],
            security_events: [{ at: NOW, action: 'auth.access_denied', by: null }] })
        case 'admin_revoke_sessions':
          return send(res, 200, { revoked: true, sessions: 2 })
        case 'system_health_check':
          return send(res, 200, { checked_at: NOW, checks: [
            { key: 'database', label: 'Database', status: 'HEALTHY', detail: 'Query answered; 48 migrations applied.' },
            { key: 'email', label: 'Email notifications', status: 'NOT_CONFIGURED', detail: 'No email provider is configured.' },
            { key: 'push', label: 'Push notifications', status: 'NOT_CONFIGURED', detail: 'No push provider is configured.' },
            { key: 'e_invoicing', label: 'E-invoicing (IRP)', status: 'NOT_CONFIGURED', detail: 'No IRP credentials are configured.' },
            { key: 'realtime', label: 'Realtime updates', status: 'NOT_CONFIGURED', detail: 'Notifications are refreshed by polling.' },
            { key: 'scheduled_jobs', label: 'Scheduled jobs', status: 'NOT_CONFIGURED', detail: 'pg_cron is not installed.' },
            { key: 'errors', label: 'Application errors (24 h)', status: 'DEGRADED', detail: '1 error reported in the last 24 hours.' },
          ], recent_errors: [{ at: NOW, source: 'client', severity: 'ERROR', code: null, message: 'Mock rendering failure', correlation_id: 'corr-123' }] })
        case 'amazon_data_status':
          return has('amazon.read') ? send(res, 200, amzStatus(body.p_demo === true)) : send(res, 403, { code: '42501', message: 'You are not allowed to perform this action (requires amazon.read).' })
        case 'amazon_product_performance':
          return send(res, 200, { from: body.p_from, to: body.p_to, today: TODAY, demo: body.p_demo, settings: AMZ_SETTINGS, rows: body.p_demo ? AMZ_PRODUCTS : [], generated_at: NOW })
        case 'amazon_campaign_performance':
          return send(res, 200, { rows: body.p_demo ? AMZ_CAMPAIGNS : [] })
        case 'amazon_daily_series':
          return send(res, 200, { days: body.p_demo ? amzDays() : [] })
        case 'amazon_search_terms':
          return send(res, 200, { total: body.p_demo ? AMZ_TERMS.length : 0, rows: body.p_demo ? AMZ_TERMS : [] })
        case 'amazon_recommendations_save':
          return send(res, 200, { saved: body.p_items.length, superseded: 0 })
        // ---- Alton Accounts --------------------------------------------------------------------------------
        case 'accounting_status':
          if (!accHasAny('accounts.read', 'vouchers.read', 'accounting_reports.read', 'accounting_settings.manage', 'accounting_posting.manage', 'accounting_opening.import')) return send(res, 403, accDenied('accounts.read'))
          return send(res, 200, { initialized: true, settings: { books_start_date: ACC_START, fy_start_month: 4, currency_code: 'INR', allow_future_dates: false, backdate_limit_days: null,
            segregation_of_duties: false, auto_posting_max_attempts: 5, initialized_at: NOW, updated_at: NOW }, current_financial_year: ACC_FY_LABEL, today: TODAY, has_postings: true,
            has_vouchers: true, default_fy_start_month: 4 })
        case 'accounting_dashboard':
          return has('accounting_reports.read') ? send(res, 200, { initialized: true, books_start_date: ACC_START, financial_year: ACC_FY_LABEL, fy_from: ACC_START, today: TODAY,
            vouchers: { draft: 1, posted: 1 + ACC.posted, reversed: 0, posted_this_fy: 1 + ACC.posted, automatic: 1, manual: ACC.posted }, books: { total_debit: '11800.00', total_credit: '11800.00' },
            events: { POSTED: 1, NEEDS_ACCOUNT_MAPPING: 1 }, periods: { open: 12, closed: 0, current: 'current (OPEN)' }, opening: { posted: false, in_progress: 1 },
            unmapped_payment_methods: ['UPI'], classification: { ASSET: '11800.00', INCOME: '-11800.00' } }) : send(res, 403, accDenied('accounting_reports.read'))
        case 'accounting_chart':
          return send(res, 200, { groups: ACC.groups, accounts: ACC.accounts })
        case 'accounting_accounts':
          return send(res, 200, ACC.accounts)
        case 'accounting_parties':
          return send(res, 200, [{ id: 'party1', party_code: 'PTY-000001', party_name: 'Mock Customer', is_customer: true, is_supplier: false, opening_balance: '2000.00', opening_balance_type: 'RECEIVABLE' }])
        case 'accounting_voucher_list':
          if (!has('vouchers.read')) return send(res, 403, accDenied('vouchers.read'))
          if (body.p_filters?.voucher_type === 'JV') {
            return send(res, 200, { total: 2, rows: [accListRow({ ...accDraft(), id: 'av3', status: 'POSTED', voucher_number: 'JV/00/000007', narration: 'Office rent accrual', posted_at: NOW }),
              accListRow(accDraft())] })
          }
          return send(res, 200, { total: 2, rows: [accListRow(accVoucher()), accListRow(accDraft())] })
        case 'accounting_voucher_get':
          return send(res, 200, body.p_voucher_id === 'av2' ? (ACC.posted ? { ...accDraft(), status: 'POSTED', voucher_number: 'JV/00/000001', issues: [] } : accDraft()) : accVoucher())
        case 'accounting_voucher_create':
        case 'accounting_voucher_update':
          if (!has('vouchers.create')) return send(res, 403, accDenied('vouchers.create'))
          ACC.saved = body.p_voucher
          return send(res, 200, { ...accDraft(), narration: body.p_voucher.narration, row_version: (ACC.version = (ACC.version ?? 1) + 1), issues: [] })
        case 'accounting_voucher_validate':
          return send(res, 200, { voucher_id: body.p_voucher_id, valid: true, issues: [], total_debit: 250, total_credit: 250, difference: 0 })
        case 'accounting_voucher_discard':
          return send(res, 200, { ...accDraft(), status: 'DISCARDED' })
        case 'accounting_voucher_reverse':
          if (!has('vouchers.reverse')) return send(res, 403, accDenied('vouchers.reverse'))
          ACC.reversed = body
          return send(res, 200, { original: { ...accDraft(), id: body.p_voucher_id, status: 'REVERSED' }, reversal: { ...accDraft(), id: 'av9', status: 'POSTED', voucher_number: 'REV/00/000001' } })
        case 'accounting_voucher_post':
          if (!has('vouchers.post')) return send(res, 403, accDenied('vouchers.post'))
          ACC.posted++
          return send(res, 200, { ...accDraft(), status: 'POSTED', voucher_number: 'JV/00/000001' })
        case 'accounting_trial_balance':
          return send(res, 200, { from: body.p_from, to: body.p_to, rows: [accTbRow(ACC.accounts[0], 0, '11800.00', '0'), accTbRow(ACC.accounts[2], 0, '0', '10000.00'), accTbRow(ACC.accounts[3], 0, '0', '1800.00')],
            totals: { opening_debit: '0', opening_credit: '0', period_debit: '11800.00', period_credit: '11800.00', closing_debit: '11800.00', closing_credit: '11800.00' } })
        case 'accounting_general_ledger': {
          const a = ACC.accounts.find((x) => x.id === body.p_account_id) ?? ACC.accounts[0]
          return send(res, 200, { account: { id: a.id, account_code: a.account_code, account_name: a.account_name, normal_balance: a.normal_balance, classification: a.classification, requires_party: a.requires_party },
            from: body.p_from, to: body.p_to, opening_balance: '0', closing_balance: '11800.00', entries: [{ voucher_id: 'av1', voucher_number: accVoucher().voucher_number, voucher_date: TODAY,
              voucher_type: 'SAL', status: 'POSTED', narration: 'Sales invoice INV/1', reference_number: 'INV/1', source_type: 'SALES_INVOICE', source_number: 'INV/1', party_id: null, party_name: null,
              debit: '11800.00', credit: '0', balance: '11800.00' }] })
        }
        case 'accounting_day_book':
          return send(res, 200, { from: body.p_from, to: body.p_to, vouchers: [accVoucher()], totals: { debit: '11800.00', credit: '11800.00', vouchers: 1 } })
        case 'accounting_periods':
          return send(res, 200, accPeriods())
        case 'accounting_posting_rules':
          return send(res, 200, [{ id: 'pr1', rule_key: 'SALES', match_value: '', account_id: 'acc-sales', account_code: '4100', account_name: 'Sales', account_active: true, is_active: true, updated_at: NOW }])
        case 'accounting_cost_centres':
          return send(res, 200, ACC_CC())
        case 'accounting_posting_events':
          return accHasAny('accounting_posting.manage', 'accounting_reports.read') ? send(res, 200, { counts: { POSTED: 1, NEEDS_ACCOUNT_MAPPING: 1 }, rows: accEvents(), max_attempts: 5 })
            : send(res, 403, accDenied('accounting_posting.manage'))
        case 'accounting_posting_run':
          if (!has('accounting_posting.manage')) return send(res, 403, accDenied('accounting_posting.manage'))
          ACC.runs++
          return send(res, 200, { busy: false, queued: 2, processed: 2, results: { POSTED: 1, NEEDS_ACCOUNT_MAPPING: 1 }, remaining: 0 })
        case 'accounting_cost_centre_save':
          if (!has('accounts.manage')) return send(res, 403, accDenied('accounts.manage'))
          ACC.ccSaved = body
          return send(res, 200, { id: body.p_cost_centre_id ?? 'cc9' })
        case 'accounting_cost_centre_delete':
          return send(res, 200, { deleted: body.p_cost_centre_id })
        case 'accounting_account_set_cost_centre_policy':
          return send(res, 200, { id: body.p_account_id, cost_centre_policy: body.p_policy })
        case 'accounting_cost_centre_summary':
          return send(res, 200, { from: body.p_from, to: body.p_to, rows: [
            { cost_centre_id: 'cc1', cost_centre_code: 'PROD', cost_centre_name: 'Production', parent_cost_centre_id: null, cost_centre_type: 'PRODUCTION', is_active: true, income: '6000.00',
              expense: '64000.00', net: '-58000.00', budget: '50000.00', actual: '64000.00', variance: '-14000.00', income_budget: '0' },
            { cost_centre_id: 'cc2', cost_centre_code: 'ADMIN', cost_centre_name: 'Administration', parent_cost_centre_id: null, cost_centre_type: 'ADMINISTRATION', is_active: true, income: '0',
              expense: '20000.00', net: '-20000.00', budget: '0', actual: '20000.00', variance: '-20000.00', income_budget: '0' },
            { cost_centre_id: 'cc3', cost_centre_code: 'WH', cost_centre_name: 'Warehouse', parent_cost_centre_id: 'cc2', cost_centre_type: 'WAREHOUSE', is_active: true, income: '3000.00',
              expense: '20000.00', net: '-17000.00', budget: '0', actual: '20000.00', variance: '-20000.00', income_budget: '0' }],
            unallocated: { income: '1000.00', expense: '500.00', net: '500.00' }, company: { income: '10000.00', expense: '104500.00' } })
        case 'accounting_cost_centre_profitability':
          return send(res, 200, { from: body.p_from, to: body.p_to, rows: [{ cost_centre_id: 'cc1', cost_centre_code: 'PROD', cost_centre_name: 'Production', parent_cost_centre_id: null,
            revenue: '6000.00', direct_expenses: '4000.00', indirect_expenses: '60000.00', contribution: '2000.00', net_contribution: '-58000.00' }],
            unallocated: { revenue: '1000.00', direct_expenses: '0', indirect_expenses: '500.00', net_contribution: '500.00' } })
        case 'accounting_cost_centre_ledger':
          return send(res, 200, { cost_centre: { id: 'cc1', cost_centre_code: 'PROD', cost_centre_name: 'Production' }, from: body.p_from, to: body.p_to, opening_balance: '0',
            closing_balance: '58000.00', entries: [{ voucher_id: 'av1', voucher_number: 'JV/00/000003', voucher_date: TODAY, voucher_type: 'JV', status: 'POSTED', account_id: 'acc-gst',
              account_code: '6500', account_name: 'Electricity', narration: 'Electricity bill', debit: '60000.00', credit: '0', balance: '60000.00' }] })
        case 'accounting_budget_vs_actual':
          return send(res, 200, { financial_year: body.p_financial_year, from: ACC_START, to: TODAY, upto_month: body.p_upto_month ?? 12,
            budget: { id: 'bud1', version: 1, budget_name: 'Operating budget', approved_at: NOW }, rows: [{ cost_centre_id: 'cc1', cost_centre_code: 'PROD', cost_centre_name: 'Production',
              account_id: 'acc-gst', account_code: '6500', account_name: 'Electricity', classification: 'EXPENSE', annual_budget: '600000.00', monthly_budget: '50000.00',
              period_budget: '400000.00', actual: '420000.00', remaining: '180000.00', variance: '-20000.00', variance_percent: '-5.00' }] })
        case 'accounting_budgets':
          return send(res, 200, [{ ...accBudget(ACC.budgetStatus ?? 'DRAFT'), line_count: 1 }])
        case 'accounting_budget_get':
          return send(res, 200, accBudget(ACC.budgetStatus ?? 'DRAFT'))
        case 'accounting_budget_approve':
          if (!has('accounting_budgets.approve')) return send(res, 403, accDenied('accounting_budgets.approve'))
          ACC.budgetStatus = 'APPROVED'
          return send(res, 200, accBudget('APPROVED'))
        case 'accounting_budget_create':
        case 'accounting_budget_lines_replace':
        case 'accounting_budget_revise':
        case 'accounting_budget_cancel':
          return send(res, 200, accBudget('DRAFT'))
        case 'purchase_invoice_lookups':
          return send(res, 200, piLookups())
        case 'purchase_invoice_list':
          return send(res, 200, [{ id: 'pi1', invoice_number: 'PINV-000001', supplier_id: 'sup1', supplier_name: 'Shree Ceramics', supplier_code: 'SUP1', supplier_invoice_number: 'S1/M-002',
            supplier_invoice_date: TODAY, recorded_date: TODAY, due_date: TODAY, invoice_type: 'GOODS', status: PI.status, variance_status: PI.status === 'SUBMITTED' ? 'EXCEPTION' : 'APPROVED',
            gst_status: PI.gst, taxable_value: '420.00', tax_total: '75.60', grand_total: '495.60', outstanding: PI.status === 'POSTED' ? (495.6 - PI.paid).toFixed(2) : null,
            reverse_charge: false, voucher_number: null, has_grn: true, created_by_name: 'Smoke Tester' }])
        case 'purchase_invoice_get':
          return send(res, 200, body.p_invoice_id === 'pi1' ? piInvoice('pi1') : piInvoice(body.p_invoice_id, 'DRAFT'))
        case 'purchase_invoice_save':
          if (!has('purchase_invoices.create')) return send(res, 403, accDenied('purchase_invoices.create'))
          return send(res, 200, { ...piInvoice('pi-new', 'DRAFT'), issues: [] })
        case 'purchase_invoice_submit':
          return send(res, 200, piInvoice(body.p_invoice_id, 'SUBMITTED'))
        case 'purchase_invoice_approve':
          if (!body.p_accept_variances || String(body.p_note ?? '').length < 10) return send(res, 400, { code: 'P0001', message: 'approve them explicitly' })
          PI.status = 'APPROVED'
          return send(res, 200, piInvoice())
        case 'purchase_invoice_post':
          PI.status = 'POSTED'
          return send(res, 200, piInvoice())
        case 'purchase_invoice_verify_gst':
          // Gate C: a proposal only (maker-checker); the GST stays pending until another user approves it.
          PI.proposed = body.p_status
          return send(res, 200, { ...piInvoice(), itc_stage: 'PROPOSED' })
        case 'gst_itc_get':
          return send(res, 200, { invoice_id: body.p_invoice_id, gst_status: PI.status === 'POSTED' ? PI.gst : 'PENDING_VERIFICATION', stage: PI.proposed ? 'PROPOSED' : PI.gst === 'ELIGIBLE' ? 'DECIDED' : null,
            history: PI.proposed ? [{ seq: 1, stage: 'PROPOSED', decision: PI.proposed, reason: 'Invoice and GSTIN checked against the supplier copy', by: 'Other Accountant', created_at: NOW, actor_id: 'u2' }] : [],
            gstr2b: { match_status: 'APPROVED', outcome: 'EXACT', doc_number: 'S1/M-002', doc_date: TODAY, return_period: '2026-10', itc_availability: 'YES', needs_review: false,
              is_current_version: true, note: 'GSTR-2B is evidence only' } })
        case 'gst_itc_action':
          if (body.p_action === 'APPROVE') { PI.gst = PI.proposed; PI.proposed = null } else PI.proposed = null
          return send(res, 200, { invoice_id: body.p_invoice_id, gst_status: PI.gst, stage: body.p_action === 'APPROVE' ? 'DECIDED' : 'REJECTED', history: [], gstr2b: { match_status: 'NOT_MATCHED', note: '' } })
        case 'gst_periods_list':
          return send(res, 200, grPeriods())
        case 'gst_dashboard':
          return send(res, 200, { registration: { gstin: '27AABCA1234A1Z5', legal_name: 'Alton', state_code: '27' }, config_version_no: 1, today: TODAY, cash: { 'CGST:TAX': '500.00' },
            challans_unpaid: 0, itc_pending: 3, gstr2b_missing_in_books: 1, note: '',
            periods: grPeriods().map((p) => ({ id: p.id, period_code: p.period_code, status: p.status, snapshot_version: p.snapshot_version, liability: { 'OUTPUT:IGST': '50.00', 'RCM:IGST': '0' },
              credit: { IGST: '350.00', CGST: '0', SGST: '0' }, set_off: p.id === 'gp-oct' ? 'POSTED' : null, filed: GR.filed && p.id === 'gp-oct' ? { GSTR3B: { arn: GR.filed } } : {} })) })
        case 'gst_return_get':
          return send(res, 200, body.p_return_type === 'GSTR1' ? grGstr1(body.p_period_id, body.p_period_id === 'gp-oct') : grGstr3b(body.p_period_id, body.p_period_id === 'gp-oct'))
        case 'gst_register':
          return send(res, 200, { register: body.p_register, from: '2026-11-01', to: '2026-11-30', note: 'Issued / posted documents only.', totals: { taxable: 900, igst: 162, cgst: 0, sgst: 0, cess: 0 },
            rows: [{ kind: 'INVOICE', id: 'si1', number: 'INV-0001', doc_date: TODAY, customer_name: 'Acme', customer_gstin: '29AABCQ1234A1Z5', place_of_supply: '29', section: 'B2B', sign: 1,
              taxable: '1000.00', igst: '180.00', cgst: '0', sgst: '0' }, { kind: 'CREDIT_NOTE', id: 'cn1', number: 'CN-0001', doc_date: TODAY, customer_name: 'Acme', customer_gstin: '29AABCQ1234A1Z5',
              place_of_supply: '29', section: 'CDNR', sign: -1, taxable: '100.00', igst: '18.00', cgst: '0', sgst: '0' }] })
        case 'gst_payments_view':
          return send(res, 200, { cash_ledger: 500, challans: [{ id: 'ch1', cpin: '26112700000001', challan_date: TODAY, status: 'PAID', heads: [{ major_head: 'CGST', minor_head: 'TAX', amount: '1000.00' }],
            payments: [{ attempt_no: 1, status: 'SUCCESS', cin: '26112700000001HDFC', voucher_number: 'GST/26-27/000003' }] }],
            set_offs: [{ id: 'so1', period_id: 'gp-oct', period_code: '2026-10', status: 'POSTED', voucher_number: 'GST/26-27/000004', lines: [{ liability_kind: 'OUTPUT', liability_head: 'IGST', source: 'CREDIT', source_head: 'IGST', amount: '150.00' }] }] })
        case 'gst_reconciliation_get':
          return send(res, 200, { period: '2026-11', note: 'Documents vs ledgers.', tax_heads: [{ head: 'IGST', output_documents: '36180.00', output_ledger: '200.00', output_difference: '-35980.00', itc_documents: '0',
            itc_ledger: '500.00', itc_difference: '500.00', rcm_documents: '0', set_off_credit: '150.00', set_off_cash: '0', open_liability: '50.00' }],
            unexplained_vouchers: [{ voucher_number: 'JV/26-27/000012', date: TODAY, source: 'MANUAL', source_type: null, account: '2230 Output IGST', debit: '0', credit: '200.00' }] })
        case 'gst_period_readiness':
          return send(res, 200, { period_id: body.p_period_id, period_code: '2026-10', controls: geControls(), blockers_failed: 0, warnings_open: 1, can_close: !GR.closed,
            lifecycle: { status: GR.closed ? 'CLOSED' : 'APPROVED', label: GR.filed ? 'FILED' : GR.closed ? 'CLOSED' : 'APPROVED', filed: GR.filed ? [{ return_type: 'GSTR3B', arn: GR.filed, filed_on: TODAY }] : [],
              reopened_count: 1 }, note: 'Blockers must pass before closing. Warnings are never treated as passed.' })
        case 'gst_period_transition':
          if (body.p_action === 'CLOSE') {
            if (!has('gst_periods.close')) return send(res, 403, accDenied('gst_periods.close'))
            if (String(body.p_reason ?? '').length < 10) return send(res, 400, { code: '22023', message: 'Open warnings must be acknowledged before closing: source errors (2).' })
            GR.closed = true
          }
          return send(res, 200, grPeriods().find((p) => p.id === body.p_period_id))
        case 'gst_control_report':
          return send(res, 200, { ...geHead(body.p_report), note: 'Read only.',
            rows: body.p_report === 'TAX_LIABILITY' ? [{ head: 'IGST', documents: 36720, ledger: 200, ledger_minus_documents: -36520, gstr1_calculated: 36720, gstr3b_calculated: 36720,
              snapshot_gstr3b: 36180, snapshot_minus_live_gstr3b: -540 }] : [],
            unexplained_vouchers: [], summary: body.p_report === 'GSTR2B' ? { EXACT: 1, PARTIAL: 1 } : [],
            documents: body.p_report === 'GSTR2B' ? [{ doc_number: 'S1/M-002', supplier_gstin: '27AABCP1234A1Z5', category: 'PARTIAL', outcome: 'PARTIAL', exact: false, tolerance: '1.00',
              config_version_no: 1, match_status: 'APPROVED' }] : [], reversed_matches: [], amendments: [], duplicates: [], missing_in_2b: [] })
        case 'gst_return_exceptions':
          return send(res, 200, { period: '2026-11', rows: grBase('gp-nov', false).exceptions })
        case 'gst_return_filing':
          if (!has('gst_returns.approve')) return send(res, 403, accDenied('gst_returns.approve'))
          if (!/^[A-Z0-9]{15}$/.test(body.p?.arn ?? '')) return send(res, 400, { code: '22023', message: 'The ARN shown by the GST portal (15 letters / digits) is required.' })
          GR.filed = body.p.arn
          return send(res, 200, { id: 'gf1', return_type: body.p.return_type, arn: body.p.arn, status: 'RECORDED', note_on_filing: 'Recorded by a user after filing on the GST portal; this system does not file returns.' })
        case 'gst_2b_imports_list':
          return send(res, 200, [g2bImport()])
        case 'gst_2b_import_get':
          return send(res, 200, { ...g2bImport(), preview: { new_documents: 2, amendments: 0, changed: 0, already_imported: 0, credit_debit_notes: 0 }, line_count: 3,
            lines: [g2bLine(1, 'VALID', 'S1/M-002'), g2bLine(2, 'VALID', 'S1/M-003'), g2bLine(3, 'ERROR', 'S1/BAD', ['Supplier GSTIN "X" is not a valid GSTIN.'])] })
        case 'gst_2b_import_commit':
          if (!has('gst_reconciliation.manage')) return send(res, 403, accDenied('gst_reconciliation.manage'))
          if (!body.p_accept_errors) return send(res, 400, { code: 'P0001', message: '1 row(s) have errors.' })
          G2B.committed = true
          return send(res, 200, g2bImport())
        case 'gst_2b_auto_match':
          return send(res, 200, { proposed: 1, ambiguous: 0, no_candidate: 1, by_outcome: { PARTIAL: 1 }, note: 'Auto-matching only proposes.' })
        case 'gst_2b_report':
          if (body.p_report === 'SUMMARY') return send(res, 200, { report: 'SUMMARY', documents: 2, invoices: 2, approved: G2B.approved ? 1 : 0, proposed: G2B.approved ? 0 : 1, missing_in_books: 1,
            credit_debit_notes: 0, needs_review: 0, imports: 1, by_outcome: { PARTIAL: 1 }, note: 'GSTR-2B reconciliation never posts vouchers and never approves ITC.' })
          return send(res, 200, { report: body.p_report, rows: body.p_report === 'MISSING_IN_BOOKS' ? [{ document_id: 'gd2', supplier_gstin: '27AABCP1234A1Z5', doc_number: 'S1/M-003', doc_date: TODAY,
            return_period: '2026-10', taxable_value: '420.00', exception: 'MISSING_IN_BOOKS' }] : [{ document_id: 'gd1', doc_type: 'INVOICE', supplier_gstin: '27AABCP1234A1Z5', doc_number: 'S1/M-002',
            doc_date: TODAY, return_period: '2026-10', version_no: 1, taxable_value: '420.00', igst: '0', cgst: '37.80', sgst: '38.30', cess: '0', match_status: G2B.approved ? 'APPROVED' : 'PROPOSED',
            outcome: 'PARTIAL', invoice_number: 'PINV-000001', needs_review: false }] })
        case 'gst_2b_document_get':
          return send(res, 200, { id: 'gd1', supplier_gstin: '27AABCP1234A1Z5', doc_type: 'INVOICE', doc_number: 'S1/M-002', doc_fy: '2026-27', supplier_name: 'Shree Ceramics', version_count: 1,
            needs_review: false, review_reason: null, versions: [{ id: 'gv1', version_no: 1, version_kind: 'ORIGINAL', return_period: '2026-10', doc_number: 'S1/M-002', doc_date: TODAY, taxable_value: '420.00',
              igst: '0', cgst: '37.80', sgst: '38.30', cess: '0', original_row: {}, file_name: 'GSTR2B_102026.xlsx', source_row: 6 }], matches: [g2bMatch()], candidates: [] })
        case 'gst_2b_match_decide':
          if (!has('gst_reconciliation.approve')) return send(res, 403, accDenied('gst_reconciliation.approve'))
          if (String(body.p_note ?? '').length < 10) return send(res, 400, { code: '22023', message: 'record why they are acceptable' })
          G2B.approved = body.p_action === 'APPROVE'
          return send(res, 200, g2bMatch())
        case 'purchase_invoice_supplier_payments':
          return send(res, 200, [{ id: 'spay1', payment_number: 'SPAY-0001', payment_date: TODAY, amount: '1000.00', payment_method: 'BANK_TRANSFER', reference: 'UTR9', unallocated: '1000.00' }])
        case 'purchase_invoice_allocate_payment':
          PI.paid = Number(body.p_amount)
          return send(res, 200, piInvoice())
        case 'purchase_invoice_matching_candidates':
          return send(res, 200, [{ line_id: 'grl2', receipt_id: 'grn2', receipt_number: 'GRN-0002', receipt_date: TODAY, receipt_type: 'DIRECT', purchase_order_id: null, po_number: null,
            description: 'Wash basin', unit: 'PCS', ordered_quantity: null, received_quantity: '10.000', accepted_quantity: '10.000', invoiced_quantity: '6.000',
            posted_invoiced_quantity: '6.000', remaining_quantity: '4.000', unit_cost: '100.0000', gst_rate: '18.00', payable: '1180.00', net: '1000.00', gst: '180.00', in_books: true }])
        case 'purchase_invoice_report':
          if (body.p_report === 'AGEING') return send(res, 200, { report: 'AGEING', as_of: TODAY, rows: [{ supplier_id: 'sup1', supplier: 'Shree Ceramics', not_due: '495.60', d1_30: '0',
            d31_60: '0', d61_90: '0', d90_plus: '0', total: '495.60', ledger_creditors: '2913.60' }] })
          return send(res, 200, { report: body.p_report, rows: [{ receipt_number: 'GRN-0001', receipt_date: TODAY, supplier: 'Shree Ceramics', description: 'Wash basin',
            accepted_quantity: 10, invoiced_quantity: 10, uninvoiced_quantity: 0, receipt_payable: '1180.00', receipt_share_invoiced: '1180.00', invoiced_amount: '1203.60',
            difference_posted: '23.60', uninvoiced_payable: '0', state: 'FULLY_INVOICED', invoices: 'PINV-000001, PINV-000002' }] })
        case 'bank_lookups':
          return send(res, 200, bkLookups())
        case 'bank_cash_account_list':
          return send(res, 200, BK_ACCOUNTS().filter((a) => !body.p_kind || a.account_kind === body.p_kind))
        case 'bank_cash_account_save':
          if (!has('bank_accounts.manage')) return send(res, 403, accDenied('bank_accounts.manage'))
          return send(res, 200, bkAcc('sbi', 'BANK', body.p_account.account_code, body.p_account.account_name))
        case 'bank_account_reveal_number':
          return send(res, 200, '50100012345678')
        case 'bank_transfer_list':
          return send(res, 200, BK.transfers)
        case 'bank_transfer_save': {
          const t = bkTransfer({ id: 'trf1', transfer_number: 'TRF-000001', transfer_date: body.p_transfer.transfer_date, from_account_id: body.p_transfer.from_account_id,
            to_account_id: body.p_transfer.to_account_id, amount: body.p_transfer.amount, charges: body.p_transfer.charges, charges_account_id: null, reference: body.p_transfer.reference,
            narration: body.p_transfer.narration, status: 'DRAFT' })
          BK.transfers = [t]
          return send(res, 200, t)
        }
        case 'bank_transfer_post':
          BK.transfers = BK.transfers.map((t) => ({ ...t, status: 'POSTED', voucher_id: 'av-ctr1', voucher_number: 'CTR/26-27/000001', posted_at: NOW }))
          return send(res, 200, BK.transfers[0])
        case 'bank_statement_imports_list':
          return send(res, 200, BK.imports)
        case 'bank_statement_import': {
          const n = body.p_rows.length
          if (!body.p_commit) return send(res, 200, { preview: true, file_name: body.p_file.name, file_sha256: 'x', previously_imported_at: null, row_count: n, importable_count: n,
            duplicate_count: 0, failed_count: 0, report: body.p_rows.map((r) => ({ row_no: r.row_no, status: 'IMPORTED', message: null })), rows: body.p_rows })
          BK.imports = [{ id: 'imp1', bank_cash_account_id: body.p_account_id, account_code: 'HDFC-CA', account_name: 'HDFC Current', file_name: body.p_file.name, file_size: 100, row_count: n,
            imported_count: n, duplicate_count: 0, failed_count: 0, statement_from: TODAY, statement_to: TODAY, imported_at: NOW, imported_by_name: 'Smoke Tester' }]
          return send(res, 200, { ...BK.imports[0], preview: false, previously_imported_at: null, report: [] })
        }
        case 'bank_reconciliation_workspace':
          return send(res, 200, { account: BK_ACCOUNTS()[0], ledger: bkLedger(), statement: bkStatement(), matches: BK.matched ? [{ id: 'm1', method: 'MANUAL', reason: 'transfer plus charges',
            total: '-1025.00', effective_date: TODAY, created_at: NOW, created_by_name: 'Smoke Tester', items: [{ statement_line_id: 'st1', voucher_line_id: null, amount: '-1025.00' }] }] : [] })
        case 'bank_reconciliation_suggestions':
          return send(res, 200, [])
        case 'bank_reconciliation_match':
          BK.matched = true
          return send(res, 200, { match_id: 'm1' })
        case 'bank_statement_adjustment_proposal':
          return send(res, 200, { direction: 'WITHDRAWAL', proposal: 'Dr the chosen expense ledger / Cr the bank ledger', suggested_category: 'CHARGES', possible_duplicates: [],
            accounts: [{ id: 'acc-6600', account_code: '6600', account_name: 'Bank Charges', cost_centre_policy: 'OPTIONAL' }] })
        case 'bank_statement_adjust':
          BK.adjusted = true
          return send(res, 200, { voucher_id: 'av-bnk', voucher_number: 'BNK/26-27/000001', statement_line_id: body.p_line_id })
        case 'bank_reconciliation_statement':
        case 'bank_reconciliation_save': {
          const open = !(BK.matched && BK.adjusted)
          return send(res, 200, { as_of: TODAY, ledger_balance: '196036.00', statement_balance: open ? '193916.00' : '196036.00', statement_balance_source: 'STATEMENT', outstanding_deposits: '0',
            outstanding_payments: '0', unrecorded_credits: '0', unrecorded_debits: open ? '1084.00' : '0', adjusted_bank_balance: open ? '193916.00' : '196036.00',
            adjusted_book_balance: open ? '194952.00' : '196036.00', difference: open ? '-1036.00' : '0', ledger_items: [], statement_items: [], last_reconciliation: null,
            ...(fn === 'bank_reconciliation_save' ? { id: 'r1', status: 'COMPLETED' } : {}) })
        }
        case 'bank_reconciliation_history':
          return send(res, 200, [])
        case 'bank_cash_book':
          return send(res, 200, { account: BK_ACCOUNTS().find((a) => a.id === body.p_account_id) ?? BK_ACCOUNTS()[0], from: body.p_from, to: body.p_to, opening_balance: '0',
            closing_balance: '196036.00', total_debit: '204120.00', total_credit: '8084.00', daily: [{ date: TODAY, opening: '0', receipts: '204120.00', payments: '8084.00', closing: '196036.00' }],
            rows: [{ line_id: 'b1', voucher_id: 'av-cq', voucher_number: 'PMT/26-27/000009', date: TODAY, txn_type: 'PAYMENT', is_reversal: false, counterparty: 'Shree Ceramics', party_id: null,
              narration: 'Supplier payment by cheque', debit: '0', credit: '2000.00', balance: '196036.00', reference: 'CHQ-000123', payment_method: 'CHEQUE', matched: '0', reconciliation: 'UNMATCHED' }] })
        case 'bank_report':
          return send(res, 200, { report: body.p_report, rows: [{ account_code: 'HDFC-CA', voucher_date: TODAY, voucher_number: 'PMT/26-27/000009', counterparty: 'Shree Ceramics', reference: 'CHQ-000123',
            remaining: '-2000.00', days: 0, category: 'OUTSTANDING_CHEQUE' }] })
        case 'bank_payment_policies':
          return send(res, 200, ['RECEIPT', 'PAYMENT'].flatMap((d) => ['BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'DEMAND_DRAFT', 'OTHER'].map((m) => ({ direction: d, payment_method: m,
            require_selection: d === 'PAYMENT' && m === 'CASH' && BK.policyCash, rule_account_id: null, rule_account_code: null, rule_account_name: null, mapped_account_id: null,
            mapped_account_code: null, mapped_account_name: null }))))
        case 'bank_payment_policy_save':
          if (!has('accounting_settings.manage')) return send(res, 403, accDenied('accounting_settings.manage'))
          if (body.p_direction === 'PAYMENT' && body.p_method === 'CASH') BK.policyCash = body.p_require_selection
          return send(res, 200, { direction: body.p_direction, payment_method: body.p_method, require_selection: body.p_require_selection })
        case 'bank_payment_candidates':
          return send(res, 200, [{ source_type: 'SUPPLIER_PAYMENT', source_id: 'spay9', number: 'SPAY-000009', date: TODAY, party: 'Shree Ceramics', payment_method: 'CASH', amount: '500.00',
            reference: 'PC-1', payment_status: 'RECORDED', event_status: 'NEEDS_ACCOUNT_MAPPING', event_message: null, voucher_number: null, posted_account_code: null, posted_ledger_code: null,
            assigned_account_id: null, assigned_account_code: null, assignment_reason: null, require_selection: true, state: 'NEEDS_SELECTION' }])
        case 'bank_payment_assign':
          return send(res, 200, { assignment_id: 'as1' })
        case 'accounting_opening_batches':
          return send(res, 200, [{ id: 'ob1', batch_number: 'OB-0001', as_of_date: ACC_START, status: 'DRAFT', source: 'MANUAL', file_name: null, notes: null, created_at: NOW, posted_at: null,
            voucher_number: null, line_count: 2, total_debit: '5000.00', total_credit: '5000.00' }])
        case 'accounting_opening_batch_get':
          return send(res, 200, accOpening())
        case 'audit_log_filters':
          return send(res, 200, { modules: ['auth', 'inventory'], actors: [{ id: MANAGER_ID, name: 'Smoke Tester' }, { id: VIEWER_ID, name: 'Viewer Tester' }] })
        default:
          return send(res, 200, null)
      }
    }

    if (url.pathname === '/rest/v1/product_categories' && req.method === 'POST') {
      if (categories.some((c) => c.name.toLowerCase() === String(body.name).toLowerCase())) {
        return send(res, 409, { code: '23505', message: 'duplicate key value violates unique constraint "product_categories_company_name_unique"' })
      }
      const row = { id: `cat-${++insertCounter}`, company_id: body.company_id, code: body.code, name: body.name, description: body.description ?? null, is_active: true,
        created_by: MANAGER_ID, updated_by: MANAGER_ID, created_at: NOW, updated_at: NOW }
      categories.push(row)
      return send(res, 201, single ? row : [row])
    }
    if (url.pathname === '/rest/v1/product_categories') return send(res, 200, categories)

    if (url.pathname === '/rest/v1/product_master_list' && req.method === 'GET') {
      const rows = filterRows(products.map(masterRow), url.searchParams)
      if (single) return rows[0] ? send(res, 200, rows[0]) : send(res, 406, { code: 'PGRST116', message: 'not found' })
      return send(res, 200, rows, { 'Content-Range': rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0' })
    }
    if (url.pathname === '/rest/v1/products') {
      if (req.method === 'GET') {
        const rows = filterRows(products, url.searchParams)
        if (single) return rows[0] ? send(res, 200, rows[0]) : send(res, 406, { code: 'PGRST116', message: 'not found' })
        return send(res, 200, rows, { 'Content-Range': rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0' })
      }
      if (req.method === 'POST') {
        const rows = (Array.isArray(body) ? body : [body]).map((r) => ({ ...product(++insertCounter), ...r, id: `p${insertCounter}` }))
        products.push(...rows)
        if (single) return send(res, 201, { id: rows[0].id })
        return send(res, 201)
      }
      if (req.method === 'PATCH') {
        // The Cost of an edit is kept (the database mirrors it into standard_manufacturing_cost), so the list shows the
        // saved value. Other fields are not kept: later steps (purchase orders, GST previews, deactivation) use the original catalogue.
        for (const field of ['standard_cost', 'mrp', 'base_unit', 'image_url']) {
          if (body && field in body) for (const p of filterRows(products, url.searchParams)) p[field] = body[field]
        }
        if (body && 'standard_cost' in body) for (const p of filterRows(products, url.searchParams)) p.standard_manufacturing_cost = body.standard_cost
        return send(res, 204, undefined, { 'Content-Range': '*/1' })
      }
    }

    if (url.pathname === '/rest/v1/suppliers' && req.method === 'POST') {
      const list = tables.suppliers
      if (body.gstin && list.some((s) => s.gstin === body.gstin)) {
        return send(res, 409, { code: '23505', message: 'duplicate key value violates unique constraint "suppliers_company_gstin_unique"' })
      }
      const code = body.supplier_code ?? `SUP-${String(++insertCounter).padStart(6, '0')}`
      const row = { ...supplierRow(`sup-${code}`, code), ...body, supplier_code: code }
      list.push(row)
      return send(res, 201, single ? row : [row])
    }
    if (url.pathname === '/rest/v1/suppliers' && req.method === 'PATCH') {
      const id = url.searchParams.get('id')?.slice(3)
      const row = tables.suppliers.find((s) => s.id === id)
      if (row) Object.assign(row, body)
      return send(res, 204, undefined, { 'Content-Range': row ? '*/1' : '*/0' })
    }

    const table = url.pathname.replace('/rest/v1/', '')
    if (table === 'goods_receipt_lines' && req.method === 'GET') {
      // Support check for actual purchase costs: an older database does not know the column.
      return GRN_COST_COLUMNS ? send(res, 200, [], { 'Content-Range': '*/0' })
        : send(res, 400, { code: '42703', message: 'column goods_receipt_lines.po_unit_cost does not exist', details: null, hint: null })
    }
    if ((req.method === 'PATCH' || req.method === 'POST') && ['company_settings', 'profiles'].includes(table)) {
      return send(res, req.method === 'POST' ? 201 : 204, undefined, { 'Content-Range': '*/1' })
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && table in tables) {
      const rows = filterRows(tables[table], url.searchParams)
      if (single) return rows[0] ? send(res, 200, rows[0]) : send(res, 406, { code: 'PGRST116', message: 'not found' })
      return send(res, 200, rows, { 'Content-Range': rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0' })
    }
    return send(res, 404, { message: 'not mocked: ' + url.pathname })
  })
})


// Stock valuation (migration 20261125090000): p1 has two costed lots, MOCK-CLAY has no cost.
Object.assign(tables, {
  inventory_product_stock_value: [
    { ...tables.inventory_product_stock[0], unit_cost: 458.5714285714, stock_value: 64200, valued_on_hand: 140, unvalued_on_hand: 0, valuation_status: 'VALUED' },
    { ...tables.inventory_product_stock[0], product_id: 'p3', sku: 'MOCK-CLAY', product_name: 'Mock ceramic body', barcode: null, category_name: 'Raw materials', product_type: 'RAW_MATERIAL',
      base_unit: 'KG', on_hand: 50, reserved: 0, available: 50, in_house_on_hand: 50, outsourced_on_hand: 0, unit_cost: null, stock_value: null, valued_on_hand: 0, unvalued_on_hand: 50,
      valuation_status: 'NOT_VALUED' },
  ],
  inventory_balance_value: [
    { balance_id: 'b1', company_id: COMPANY_ID, product_id: 'p1', batch_id: 'lot-IN_HOUSE', warehouse_id: 'w1', location_id: 'l1', on_hand: 100, unit_cost: 450, stock_value: 45000 },
    { balance_id: 'b2', company_id: COMPANY_ID, product_id: 'p1', batch_id: 'lot-OUTSOURCED', warehouse_id: 'w1', location_id: 'l1', on_hand: 40, unit_cost: 480, stock_value: 19200 },
  ],
})
function stockValueSummary(unit, search) {
  const term = (search ?? '').toLowerCase()
  const rows = tables.inventory_product_stock_value.filter((r) => (!unit || r.base_unit === unit) && (!term || [r.sku, r.product_name, r.barcode].some((v) => String(v ?? '').toLowerCase().includes(term))))
  const units = [...new Set(rows.map((r) => r.base_unit))].sort().map((u) => {
    const of = rows.filter((r) => r.base_unit === u)
    const sum = (k) => of.reduce((s, r) => s + Number(r[k]), 0)
    return { unit: u, on_hand: sum('on_hand'), reserved: sum('reserved'), available: sum('available') }
  })
  return { products: rows.length, units, total_value: rows.reduce((s, r) => s + Number(r.stock_value ?? 0), 0),
    valued_products: rows.filter((r) => r.valuation_status === 'VALUED').length, partly_valued_products: rows.filter((r) => r.valuation_status === 'PARTIAL').length,
    not_valued_products: rows.filter((r) => r.valuation_status === 'NOT_VALUED').length,
    unvalued_units: [...new Set(rows.filter((r) => Number(r.unvalued_on_hand) > 0).map((r) => r.base_unit))].sort()
      .map((u) => ({ unit: u, quantity: rows.filter((r) => r.base_unit === u).reduce((s, r) => s + Number(r.unvalued_on_hand ?? 0), 0) })), method: 'mock' }
}

// User management lists the company's profiles and their role assignments.
Object.assign(tables, {
  profiles: [
    { id: '44444444-4444-4444-8444-444444444444', full_name: 'Owner Tester', email: 'owner@test.invalid', is_active: true, created_at: NOW, company_id: COMPANY_ID },
    { id: '22222222-2222-4222-8222-222222222222', full_name: 'Smoke Tester', email: 'manager@test.invalid', is_active: true, created_at: NOW, company_id: COMPANY_ID },
  ],
  user_roles: [
    { id: 'ur1', user_id: '44444444-4444-4444-8444-444444444444', role_id: 'r-super', company_id: COMPANY_ID },
    { id: 'ur2', user_id: '22222222-2222-4222-8222-222222222222', role_id: 'r-sales', company_id: COMPANY_ID },
  ],
  roles: ROLE_CATALOG.map(({ id, code, name, description }) => ({ id, code, name, description, is_system: true })),
})

// ---------------------------------------------------------------------------
// Static server for the built app (SPA fallback)
// ---------------------------------------------------------------------------
const distDir = path.join(root, 'dist-smoke')
if (!existsSync(distDir)) {
  console.error('Build first: npm run build:smoke')
  process.exit(2)
}
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' }
const app = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  let file = path.join(distDir, p)
  if (!file.startsWith(distDir) || !existsSync(file) || p === '/') file = path.join(distDir, 'index.html')
  else if (!path.extname(file)) file = path.join(distDir, 'index.html')
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})

// Long keep-alive: the default 5 s lets the browser reuse a socket the server is closing, which surfaces as
// an intermittent 'Failed to fetch dynamically imported module' in the browser.
for (const s of [api, app]) { s.keepAliveTimeout = 120_000; s.headersTimeout = 125_000 }
await new Promise((r) => api.listen(API_PORT, r))
await new Promise((r) => app.listen(APP_PORT, r))

// ---------------------------------------------------------------------------
// Browser over CDP
// ---------------------------------------------------------------------------
const browserPath = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync)
if (!browserPath) {
  console.error('No Edge/Chrome found')
  process.exit(2)
}
const profileDir = path.join(os.tmpdir(), `alton-smoke-${Date.now()}`)
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
  '--window-size=1440,1000', '--no-first-run', 'about:blank',
], { stdio: 'ignore' })

async function cdpJson(p, method = 'GET') {
  for (let i = 0; i < 50; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${CDP_PORT}${p}`, { method })).json()
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  throw new Error('CDP not reachable')
}

const target = await cdpJson('/json/new?about:blank', 'PUT')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let msgId = 0
const pending = new Map()
const consoleErrors = []
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
  if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '))
  }
})
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })

await cdp('Page.enable')
await cdp('Runtime.enable')
await cdp('DOM.enable')
// Product image links: images of the test host https://img.smoke.example are served here (a PNG; "broken" ones answer 404).
const SMOKE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.method !== 'Fetch.requestPaused') return
  const broken = msg.params.request.url.includes('broken')
  void cdp('Fetch.fulfillRequest', broken
    ? { requestId: msg.params.requestId, responseCode: 404, responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }], body: '' }
    : { requestId: msg.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: SMOKE_PNG }).catch(() => {})
})
await cdp('Fetch.enable', { patterns: [{ urlPattern: 'https://img.smoke.example/*' }] })
const downloadDir = path.join(outDir, 'downloads')
mkdirSync(downloadDir, { recursive: true })
await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir }).catch(() => {})

const evaluate = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed')
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(expression, label, timeout = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      // Coerce to boolean: DOM nodes are not serialisable over CDP.
      if (await evaluate(`!!(${expression})`)) return
    } catch {
      // page navigating
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for: ${label}`)
}
const bodyHas = (text) => `document.body && document.body.innerText.includes(${JSON.stringify(text)})`
const bodyHasAll = (...texts) => texts.map((x) => `(${bodyHas(x)})`).join(' && ')
/** Case-insensitive (CSS text-transform changes innerText of table headers). */
const bodyHasAllCI = (...texts) => texts.map((x) => `(document.body && document.body.innerText.toLowerCase().includes(${JSON.stringify(x.toLowerCase())}))`).join(' && ')
const goto = async (p) => {
  await cdp('Page.navigate', { url: `http://localhost:${APP_PORT}${p}` })
  await sleep(300)
}
/** Types into the email editor (contentEditable): replaces its content as a user would. */
const fillEditor = (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, ${JSON.stringify(value)}); return true })()`)
const fill = (selector, value) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('no element ${selector}');
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
/** Real mouse click at the centre of the first element matching a selector (optionally containing text). */
async function click(selector, text) {
  // Measured after scrolling has settled (two frames), so a late layout change does not move the target under the pointer.
  const rect = await evaluate(`(async () => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter((e) => ${text ? `e.innerText.trim().includes(${JSON.stringify(text)})` : 'true'})
      .filter((e) => e.getBoundingClientRect().width > 0);
    const el = els[0];
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`)
  if (!rect) throw new Error(`click: nothing matches ${selector} ${text ?? ''}`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1, pointerType: 'mouse' })
  }
  await sleep(150)
}
async function screenshot(name) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64'))
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
const results = []
// SMOKE_ONLY=<regex>: run only matching steps (sign-in steps always run). Unset: every step.
const ONLY = process.env.SMOKE_ONLY ? new RegExp(process.env.SMOKE_ONLY, 'i') : null
async function step(name, fn) {
  if (ONLY && !ONLY.test(name) && !/signs in/.test(name)) return
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ✓ ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error: error.message })
    console.log(`  ✗ ${name}: ${error.message}`)
    await screenshot(`FAILED-${results.length}`).catch(() => {})
  }
}
const writes = () => requests.filter((r) => r.path === '/rest/v1/products' && r.method !== 'GET')
const assert = (cond, message) => {
  if (!cond) throw new Error(message)
}

async function login(email, password = 'correct-horse') {
  await goto('/login')
  await waitFor(`document.querySelector('#login-email')`, 'login form')
  await fill('#login-email', email)
  await fill('#login-password', password)
  await click('button[type=submit]')
}

console.log('UI smoke test (mock API):')

// The logo must load, keep the original 2354x621 aspect ratio (object-fit: contain) and stay within its size limits.
const logoBox = (selector) => evaluate(`(() => {
  const img = [...document.querySelectorAll(${JSON.stringify(selector)})].find((i) => i.getBoundingClientRect().width > 0);
  if (!img) return null;
  const r = img.getBoundingClientRect();
  const fit = getComputedStyle(img).objectFit;
  // Rendered content box of an object-fit: contain image = the drawn logo size.
  const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
  return { alt: img.alt, src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0, w: r.width, h: r.height, fit,
    drawnRatio: (img.naturalWidth * scale) / (img.naturalHeight * scale), naturalRatio: img.naturalWidth / img.naturalHeight, bg: getComputedStyle(img.parentElement).backgroundColor };
})()`)
const assertLogo = (b, where, minW, maxW, maxH, backing = 'rgb(255, 255, 255)') => {
  assert(b, `${where}: no visible logo`)
  assert(b.loaded, `${where}: logo image did not load (${b.src})`)
  assert(b.src === '/alton-logo.png' && b.alt === 'ALTON Sanitary Ware logo', `${where}: wrong src/alt ${b.src} / ${b.alt}`)
  assert(b.fit === 'contain' && Math.abs(b.drawnRatio - b.naturalRatio) < 0.01, `${where}: aspect ratio not preserved`)
  assert(b.w >= minW && b.w <= maxW && b.h <= maxH, `${where}: size ${Math.round(b.w)}x${Math.round(b.h)} outside ${minW}-${maxW} x <=${maxH}`)
  assert(b.bg === backing, `${where}: logo backing is ${b.bg}, expected ${backing}`)
}
const setViewport = (width, height) => cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 })
const noHorizontalScroll = () => evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')

await step('login page shows the ALTON logo (loaded, original aspect ratio, transparent on the grey page)', async () => {
  await goto('/login')
  await waitFor(`document.querySelector('img[alt="ALTON Sanitary Ware logo"]')?.complete`, 'login logo')
  assertLogo(await logoBox('img[alt="ALTON Sanitary Ware logo"]'), 'login', 150, 190, 56, 'rgba(0, 0, 0, 0)')
  await setViewport(390, 844)
  await sleep(300)
  assertLogo(await logoBox('img[alt="ALTON Sanitary Ware logo"]'), 'login (mobile)', 150, 190, 56, 'rgba(0, 0, 0, 0)')
  assert(await noHorizontalScroll(), 'login page scrolls horizontally on mobile')
  await screenshot('00-login-logo-mobile')
  await cdp('Emulation.clearDeviceMetricsOverride')
  await screenshot('00-login-logo')
})

await step('invalid password shows an error and stays on login', async () => {
  await login('manager@test.invalid', 'wrong')
  await waitFor(bodyHas('Incorrect email or password.'), 'error message')
})

await step('manager signs in through the login form', async () => {
  await login('manager@test.invalid')
  await waitFor(`location.pathname === '/'`, 'redirect to dashboard')
})

await step('shared layout logo: sidebar on desktop, compact header logo on tablet/mobile and with the collapsed rail', async () => {
  await waitFor(`document.querySelector('aside img[alt="ALTON Sanitary Ware logo"]')?.complete`, 'sidebar logo')
  assertLogo(await logoBox('aside img[alt="ALTON Sanitary Ware logo"]'), 'sidebar (desktop)', 130, 160, 48)
  assert(!(await logoBox('header img[alt="ALTON Sanitary Ware logo"]')), 'header logo duplicated next to the expanded desktop sidebar')
  await screenshot('01-logo-desktop')
  for (const [w, h, name] of [[820, 1180, 'tablet'], [390, 844, 'mobile']]) {
    await setViewport(w, h)
    await sleep(400)
    assertLogo(await logoBox('header img[alt="ALTON Sanitary Ware logo"]'), `header (${name})`, 70, 110, 32)
    assert(await noHorizontalScroll(), `${name}: page scrolls horizontally`)
    await screenshot(`01-logo-${name}`)
  }
  await click('button[aria-label="Open navigation"]')
  await sleep(400)
  assertLogo(await logoBox('aside img[alt="ALTON Sanitary Ware logo"]'), 'sidebar drawer (mobile)', 130, 160, 48)
  await screenshot('01-logo-mobile-drawer')
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await cdp('Emulation.clearDeviceMetricsOverride')
  await goto('/')
  await waitFor(`document.querySelector('aside img[alt="ALTON Sanitary Ware logo"]')?.complete`, 'desktop again')
  // Collapsed desktop rail: the rail shows a small undistorted logo and the header shows the compact one.
  await click('button[aria-label="Collapse sidebar"]')
  await sleep(400)
  assertLogo(await logoBox('aside img[alt="ALTON Sanitary Ware logo"]'), 'collapsed rail', 40, 56, 48)
  assertLogo(await logoBox('header img[alt="ALTON Sanitary Ware logo"]'), 'header (collapsed rail)', 90, 110, 32)
  await screenshot('01-logo-collapsed')
  await click('button[aria-label="Expand sidebar"]')
  await sleep(400)
  assert(!(await logoBox('header img[alt="ALTON Sanitary Ware logo"]')), 'header logo still shown after expanding the sidebar')
})

await step('sidebar sections expand and collapse independently, follow the current page and keep the rail', async () => {
  const sections = `[...document.querySelectorAll('aside nav button[aria-expanded]')]`
  const section = (label) => `${sections}.find((b) => b.innerText.trim().toLowerCase() === ${JSON.stringify(label.toLowerCase())})`
  const isOpen = (label) => evaluate(`${section(label)}?.getAttribute('aria-expanded') === 'true'`)
  const regionOf = (label) => `document.getElementById(${section(label)}.getAttribute('aria-controls'))`
  const visibleHeight = (label) => evaluate(`${regionOf(label)}.getBoundingClientRect().height`)
  const pushRoute = (p) => evaluate(`(history.pushState({}, '', ${JSON.stringify(p)}), dispatchEvent(new PopStateEvent('popstate')), true)`)

  await evaluate(`localStorage.removeItem('alton-erp:sidebar-sections')`)
  await goto('/inventory/stock')
  await waitFor(`${sections}.length > 0`, 'section headings')

  // Every visible section except Overview is a toggle; Dashboard stays a plain, always-reachable link.
  const labels = await evaluate(`${sections}.map((b) => b.innerText.trim())`)
  assert(labels.length >= 2 && !labels.some((l) => /^(overview|management dashboard)$/i.test(l)), `unexpected section toggles: ${labels.join(', ')}`)
  assert(await evaluate(`(() => { const a = document.querySelector('aside a[href="/"]'); return a && !a.closest('[inert]') && a.getBoundingClientRect().height > 0 })()`), 'Dashboard link hidden')
  assert(await evaluate(`[...document.querySelectorAll('aside nav > div')].every((d) => d.querySelectorAll('a').length > 0)`), 'a section with no entries is shown')

  // The current page's section opened by itself; others start closed and their links cannot be focused.
  assert(await isOpen('Inventory Management'), 'Inventory did not open for /inventory/stock')
  assert(await evaluate(`document.querySelector('aside a[aria-current="page"]')?.getAttribute('href') === '/inventory/stock'`), 'Stock Register not highlighted')
  assert(!(await isOpen('Sales & Orders')), 'Sales open without being clicked')
  assert(await evaluate(`${regionOf('Sales & Orders')}.inert === true`), 'closed section is still focusable')
  assert((await visibleHeight('Sales & Orders')) < 1, 'closed section takes space')

  // Several sections can be open at once; the chevron turns.
  // Headings are uppercased by CSS, which innerText (used by click) reflects.
  await click('aside nav button[aria-expanded]', 'SALES & ORDERS')
  await sleep(350)
  assert((await isOpen('Sales & Orders')) && (await isOpen('Inventory Management')), 'opening one section closed another')
  assert((await visibleHeight('Sales & Orders')) > 100, 'opened section did not grow')
  assert(await evaluate(`${section('Sales & Orders')}.querySelector('svg').classList.contains('rotate-180')`), 'chevron did not rotate')
  await screenshot('01-sidebar-sections')

  // Closing a section only closes that one; a closed section that holds the current page is tinted.
  await click('aside nav button[aria-expanded]', 'INVENTORY MANAGEMENT')
  await sleep(350)
  assert(!(await isOpen('Inventory Management')) &&(await isOpen('Sales & Orders')), 'closing affected another section')
  assert(await evaluate(`${section('Inventory Management')}.classList.contains('text-primary')`), 'closed section with the current page not marked')

  // Navigating inside an open section works and highlights the entry.
  await click('aside a[href="/sales/orders"]')
  await waitFor(`location.pathname === '/sales/orders'`, 'navigated to Sales Orders')
  await waitFor(`document.querySelector('aside a[aria-current="page"]')?.getAttribute('href') === '/sales/orders'`, 'Sales Orders highlighted')

  // In-app navigation to a page in a closed section opens it (Inventory was closed by hand above).
  await pushRoute('/inventory/movements')
  await waitFor(`${section('Inventory Management')}?.getAttribute('aria-expanded') === 'true'`, 'Inventory reopened for its page')
  assert(await evaluate(`document.querySelector('aside a[aria-current="page"]')?.getAttribute('href') === '/inventory/movements'`), 'Stock Movements not highlighted')

  // Open sections survive a reload.
  await goto('/inventory/movements')
  await waitFor(`${sections}.length > 0`, 'sidebar after reload')
  assert(await isOpen('Sales & Orders'), 'open sections were not remembered')

  // With everything open the menu still scrolls inside the sidebar.
  // Exact label match.
  for (const l of labels) if (!(await isOpen(l))) await evaluate(`${section(l)}.click()`)
  await sleep(350)
  assert(await evaluate(`${sections}.every((b) => b.getAttribute('aria-expanded') === 'true')`), 'not every section opened')
  assert(await evaluate(`(() => { const n = document.querySelector('aside nav'); n.scrollTop = n.scrollHeight; return n.scrollHeight > n.clientHeight && n.scrollTop > 0 })()`), 'sidebar does not scroll')
  await evaluate(`document.querySelector('aside nav').scrollTop = 0`)

  // Icon rail: every entry is shown, as before, with no section toggles.
  await click('button[aria-label="Collapse sidebar"]')
  await sleep(350)
  assert(await evaluate(`${sections}.length === 0 && !document.querySelector('aside nav [inert]')`), 'rail hides entries behind sections')
  assert(await evaluate(`[...document.querySelectorAll('aside nav a')].every((a) => a.getBoundingClientRect().height > 0)`), 'rail entry not visible')
  await click('button[aria-label="Expand sidebar"]')
  await sleep(350)

  // Mobile drawer uses the same sections.
  await setViewport(390, 844)
  await sleep(300)
  await click('button[aria-label="Open navigation"]')
  await sleep(400)
  await click('aside nav button[aria-expanded]', 'INVENTORY MANAGEMENT')
  await sleep(350)
  assert(!(await isOpen('Inventory Management')), 'section did not close in the mobile drawer')
  assert(await noHorizontalScroll(), 'mobile: page scrolls horizontally')
  await screenshot('01-sidebar-mobile')
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await cdp('Emulation.clearDeviceMetricsOverride')
  await evaluate(`localStorage.removeItem('alton-erp:sidebar-sections')`)
  await goto('/')
})

await step('product list renders KPIs and rows from the API', async () => {
  await goto('/products')
  await waitFor(bodyHas('MOCK-WC-1'), 'product rows')
  for (const text of ['Product Master', 'Manage product information, SKUs, sourcing and classification.', 'Total Active Products', 'Finished Goods', 'Raw Materials', 'Components', 'Without BOM', 'Missing Information', 'Add Product', 'Import from Excel', 'Export']) {
    assert(await evaluate(bodyHas(text)), `missing "${text}"`)
  }
  await screenshot('01-product-list')
})

await step('search and sort are sent to the database (server-side)', async () => {
  const before = requests.length
  await fill('input[aria-label="Search products"]', 'WC')
  await sleep(600)
  const searched = requests.slice(before).find((r) => r.path === '/rest/v1/products' && r.query.includes('ilike'))
  assert(searched, 'no ilike filter request')
  // Quoted value: SKUs are free format, so any character is searched literally (20261120090000).
  assert(decodeURIComponent(searched.query).includes('or=(sku.ilike."%WC%"'), `unexpected search query ${searched.query}`)
  await click('th button', 'SKU')
  await sleep(400)
  assert(requests.slice(before).some((r) => r.path === '/rest/v1/products' && r.query.includes('order=sku.desc')), 'no sort request')
  assert(requests.slice(before).every((r) => !r.query.includes('limit=') || r.query.includes('limit=25')), 'page size not applied')
})

await step('add-product form validates before saving', async () => {
  await goto('/products/new')
  await waitFor(`document.querySelector('#p-sku')`, 'form')
  const writesBefore = writes().length
  await click('button[type=submit]', 'Save product')
  // V2: only name and type are required (a blank SKU gets an automatic code).
  await waitFor(bodyHas('Product name is required.'), 'required errors')
  assert(await evaluate(bodyHas('Select a product type.')), 'product type error missing')
  assert(!(await evaluate(bodyHas('SKU is required.'))), 'SKU is still required')
  assert(await evaluate(bodyHas('Please correct the highlighted fields')), 'summary banner missing')
  assert(writes().length === writesBefore, 'invalid form was sent to the API')
})

await step('add-product saves only after the API confirms and offers "add another"', async () => {
  await fill('#p-sku', 'NEW-WB-1')
  await fill('#p-product_name', 'New Basin')
  await fill('#p-gst_rate', '18')
  // V2 enhancements: MRP (separate from the selling price), planning in days, dimensions, supplier details.
  await fill('#p-mrp', '2499.50')
  await fill('#p-lead_time_days', '7.5')
  await fill('#p-reorder_level_days', '14')
  await fill('#p-length_cm', '32.5')
  await fill('#p-height_cm', '9')
  await fill('#p-supplier_model_number', 'SM-100')
  await fill('#p-supplier_product_name', 'Vendor Basin Deluxe')
  assert(!(await evaluate(bodyHas('Minimum Stock Level'))), 'the Minimum Stock Level field is still on the form')
  assert(await evaluate(bodyHasAll('Lead Time (Days)', 'Reorder Level (Days)', 'MRP (₹)', 'Dimensions', 'Supplier Model No.', 'Supplier Product Name')), 'new fields missing')
  // Category: "+ Add New Category" saves to the category master and selects it.
  await click('#p-category')
  await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('Add New Category'))`, 'add-category option')
  await click('[role=option]', 'Add New Category')
  await waitFor(`document.querySelector('#new-cat-name')`, 'add-category dialog')
  await fill('#new-cat-name', 'wash basins')
  await click('button[type=submit]', 'Save category')
  await waitFor(bodyHas('already exists'), 'duplicate category name refused')
  await fill('#new-cat-name', 'Smoke Taps')
  await fill('#new-cat-desc', 'Created from the product form')
  await click('button[type=submit]', 'Save category')
  await waitFor(bodyHas('Category “Smoke Taps” created and selected.'), 'category created and selected')
  assert(await evaluate(`document.querySelector('#p-category').innerText.includes('Smoke Taps')`), 'new category not selected')
  const catInsert = requests.filter((r) => r.path === '/rest/v1/product_categories' && r.method === 'POST').at(-1)
  assert(catInsert && catInsert.body.name === 'Smoke Taps' && catInsert.body.code === 'SMOKE-TAPS' && catInsert.body.description === 'Created from the product form', JSON.stringify(catInsert?.body))
  await click('#p-type')
  await click('[role=option]', 'Finished Good')
  await click('button[role=radio]', 'Outsourced-IMP')
  await waitFor(bodyHas('recorded on its inventory receipt'), 'make & buy explanation')
  assert(!(await evaluate(bodyHas('Please correct the highlighted fields'))), 'stale validation banner after fixing fields')
  await screenshot('02-add-product-form')
  await click('button[type=submit]', 'Save product')
  await waitFor(bodyHas('Product NEW-WB-1 saved'), 'success panel')
  const insert = writes().at(-1)
  assert(insert.method === 'POST', 'expected POST')
  assert(insert.body.company_id === COMPANY_ID && insert.body.sku === 'NEW-WB-1', 'wrong insert payload')
  assert(insert.body.default_source_type === 'HYBRID' && insert.body.product_type === 'FINISHED_GOOD', 'wrong classification')
  assert(insert.body.gst_rate === 18 && insert.body.selling_price === null, 'optional fields wrong')
  assert(insert.body.mrp === 2499.5 && insert.body.lead_time_days === 7.5 && insert.body.reorder_level_days === 14 && insert.body.reorder_level === null
    && insert.body.length_cm === 32.5 && insert.body.width_cm === null && insert.body.height_cm === 9 && insert.body.supplier_model_number === 'SM-100'
    && insert.body.supplier_product_name === 'Vendor Basin Deluxe' && String(insert.body.category_id).startsWith('cat-'), JSON.stringify(insert.body))
  assert(!('created_by' in insert.body) && !('updated_by' in insert.body), 'client sent audit fields')
  assert(await evaluate(bodyHas('Add another product')), 'no add-another option')
  await screenshot('03-add-product-saved')
})

await step('product detail page shows the record', async () => {
  await goto('/products/p1')
  await waitFor(bodyHas('Mock Closet 1'), 'detail')
  for (const text of ['Basic Information', 'Classification', 'Tax and Pricing', 'Inventory Planning', 'Manufacturing and Procurement', 'Created', 'Smoke Tester']) {
    assert(await evaluate(bodyHas(text)), `missing "${text}"`)
  }
  await screenshot('04-product-detail')
})

await step('deactivate asks for confirmation, then PATCHes status', async () => {
  const before = writes().length
  await click('button', 'Deactivate')
  await waitFor(`document.querySelector('[role=alertdialog]')`, 'confirm dialog')
  assert(writes().length === before, 'changed before confirming')
  await click('[role=alertdialog] button', 'Deactivate')
  await sleep(400)
  const patch = writes().at(-1)
  assert(patch.method === 'PATCH' && patch.body.status === 'INACTIVE' && patch.query.includes('id=eq.p1'), 'wrong status patch')
})

await step('categories page lists categories with counts', async () => {
  await goto('/products/categories')
  await waitFor(bodyHas('Water Closets / Toilets'), 'categories')
  assert(await evaluate(bodyHas('New Category')), 'no create button')
  await screenshot('05-categories')
})

// Spreadsheet with valid, invalid, duplicate and existing rows.
const xlsxPath = path.join(outDir, 'import-test.xlsx')
const xlsxAgainPath = path.join(outDir, 'import-again.xlsx')
const xlsxFieldsPath = path.join(outDir, 'import-fields.xlsx')
const xlsxBarcodePath = path.join(outDir, 'import-barcode.xlsx')
{
  const write = (file, rows) => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Products')
    writeFileSync(file, Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'array' })))
  }
  const head = ['SKU', 'Product Name', 'Category', 'Product Type', 'Source Type', 'UOM', 'GST %', 'Selling Price']
  write(xlsxPath, [
    ['Alton product list (test)'],
    [],
    head,
    ['IMP-1', 'Imported Basin', 'Wash Basins', 'Finished Good', 'In House', 'pcs', '18', '4600'], // new
    ['IMP-2', 'Imported Seat', '', 'Component', 'Outsourced', 'Nos', '', ''], // new
    ['IMP-5', 'Twice A', '', 'Finished Good', 'Outsourced', 'pcs', '', ''], // SKU twice in the file: both invalid
    ['IMP-3', 'Bad source', '', 'Finished Good', 'Factory', 'pcs', '', ''], // invalid
    ['MOCK-WC-1', 'Mock Closet 1', '', 'Finished Good', '', '', '18', '9950'], // modified: selling price only
    ['MOCK-CLAY', 'Mock ceramic body', '', 'Raw Material', '', 'kg', '', ''], // unchanged: skipped
    [' imp-5 ', 'Twice B', '', 'Finished Good', 'Outsourced', 'pcs', '', ''],
    ['IMP-4', 'Negative price', '', 'Finished Good', 'Outsourced', 'pcs', '', '-5'], // invalid
    ['', 'Mock glaze', '', 'Raw Material', '', 'kg', '', ''], // no SKU, name already in the master: invalid
  ])
  // The same products again after the import: nothing is new or changed.
  write(xlsxAgainPath, [head,
    ['IMP-1', 'Imported Basin', 'Wash Basins', 'Finished Good', 'In House', 'pcs', '18', '4600'],
    ['imp-2', 'Imported Seat', '', 'Component', 'Outsourced', 'Nos', '', ''],
    ['MOCK-CLAY', 'Mock ceramic body', '', 'Raw Material', '', 'kg', '', ''],
  ])
  // Match key Barcode: MOCK-WC-1 (barcode 8901234567890) with a new SKU and a new price.
  write(xlsxBarcodePath, [['SKU', 'Product Name', 'Barcode', 'Selling Price'], ['WC-RENAMED', '', '8901234567890', '9991']])
  // Field selection: name, GST and price differ for MOCK-WC-1; a near-miss SKU and a name in other capitals.
  write(xlsxFieldsPath, [head,
    ['mock-wc-1 ', 'Renamed closet', '', 'Finished Good', '', '', '12', '9990'],
    ['MOCK WC 1', 'Another closet', '', 'Finished Good', '', '', '', ''],
    ['', 'MOCK CERAMIC BODY', '', 'Raw Material', '', 'kg', '', ''],
  ])
}

async function uploadImportFile(file) {
  await goto('/products/import')
  await waitFor(`document.querySelector('input[type=file]')`, 'file input')
  const { root: doc } = await cdp('DOM.getDocument')
  const { nodeId } = await cdp('DOM.querySelector', { nodeId: doc.nodeId, selector: 'input[type=file]' })
  await cdp('DOM.setFileInputFiles', { nodeId, files: [file] })
  await waitFor(bodyHas('Column mapping'), 'mapping step')
}
const groupCount = (kind) => evaluate(`Number(document.querySelector('[data-testid=import-group-${kind}]')?.dataset.count ?? -1)`)

await step('smart import: preview classifies rows as new, modified, unchanged (skipped) and invalid without writing', async () => {
  await uploadImportFile(xlsxPath)
  assert(await evaluate(`document.querySelector('#imp-header').value === '3'`), 'header row not detected as row 3')
  assert(await evaluate(`document.querySelector('input[name=dup-mode][value=update]').checked`), 'smart import is not the default')
  // No red mandatory marks on the mapping.
  assert(!(await evaluate(`[...document.querySelectorAll('label')].some((l) => l.innerText.includes('*'))`)), 'a label still has a * mark')
  assert(!(await evaluate(`[...document.querySelectorAll('[id^=map-]')].some((el) => el.getAttribute('aria-invalid') === 'true')`)), 'an unmapped field is marked red')
  await waitFor(`!!document.querySelector('[data-testid=modify-fields]')`, 'fields to modify')
  const modifyCount = await evaluate(`document.querySelector('[data-testid=modify-count]').innerText`)
  const mappedFields = await evaluate(`document.querySelectorAll('[data-testid=modify-field]').length`)
  assert(modifyCount === `${mappedFields} of ${mappedFields} fields selected` && mappedFields === 7, modifyCount)
  assert(!(await evaluate(`!!document.querySelector('[data-testid=modify-field][data-field=sku]')`)), 'the SKU can be selected for modification')
  assert(await evaluate(`(() => { const s = document.querySelector('[data-testid=modify-sku]'); return !!s && s.disabled && s.dataset.state === 'checked' && s.closest('label').innerText.includes('match key') })()`), 'SKU not shown as the locked match key')
  await screenshot('06-import-mapping')
  const before = writes().length
  await click('button', 'Validate')
  await waitFor(`!!document.querySelector('[data-testid=import-summary]')`, 'preview')
  assert(writes().length === before, 'validation wrote to the database')
  assert(requests.some((r) => r.path === '/rest/v1/rpc/check_product_identifiers'), 'existing SKU lookup not performed')
  const identities = requests.filter((r) => r.path === '/rest/v1/products' && /select=id(%2C|,)sku(%2C|,)product_name/.test(r.query)).at(-1)
  assert(identities && identities.query.includes('company_id=eq.'), 'SKU / name list not read for the company: ' + identities?.query)
  const loaded = requests.filter((r) => r.path === '/rest/v1/products' && r.query.includes('id=in.')).at(-1)
  assert(loaded && loaded.query.includes('company_id=eq.'), 'stored products not limited to the company: ' + loaded?.query)
  for (const text of ['Total Excel rows', 'New products', 'Modified products', 'Unchanged — skipped', 'Duplicate / ambiguous', 'Invalid rows', 'Existing products to modify']) {
    assert(await evaluate(bodyHas(text)), `missing "${text}"`)
  }
  const counts = { new: await groupCount('new'), modified: await groupCount('modified'), skipped: await groupCount('skipped'), ambiguous: await groupCount('ambiguous'), invalid: await groupCount('invalid') }
  assert(JSON.stringify(counts) === JSON.stringify({ new: 2, modified: 1, skipped: 1, ambiguous: 3, invalid: 2 }), JSON.stringify(counts))
  // Modified: existing value next to the Excel value; only the changed field is highlighted.
  const cmp = await evaluate(`[...document.querySelectorAll('[data-testid=import-comparison][data-sku="MOCK-WC-1"] tbody tr')].map((tr) => [tr.dataset.field, tr.dataset.changed, tr.innerText.replace(/\\s+/g, ' ').trim()])`)
  const price = cmp.find((c) => c[0] === 'selling_price')
  assert(price && price[1] === 'true' && price[2].includes('₹9,800.00') && price[2].includes('₹9,950.00'), JSON.stringify(cmp))
  assert(cmp.filter((c) => c[1] === 'true').length === 1, 'unchanged fields highlighted: ' + JSON.stringify(cmp))
  assert(cmp.some((c) => c[0] === 'gst_rate' && c[1] === 'false' && c[2].includes('18%') && c[2].endsWith('Unchanged')), 'GST comparison missing')
  assert(price[2].endsWith('Update'), 'action column: ' + price[2])
  // Invalid rows are listed with their reasons (open by default).
  for (const text of ['Duplicate SKU in this file: rows 6, 10', 'Source Type "Factory"', 'A product with this name already exists (SKU MOCK-GLZ)']) {
    assert(await evaluate(bodyHas(text)), `missing "${text}"`)
  }
  await click('[data-testid=import-group-skipped] button', 'Unchanged products')
  await waitFor(bodyHas('No changes in the selected fields: the file matches the Product Master'), 'skipped list expands')
  assert(await evaluate(bodyHas('Add 2 new and update 1')), 'import button')
  await screenshot('07-import-review')
})

await step('smart import: confirm adds the new products, updates only changed fields, skips the rest; failed rows downloadable', async () => {
  const before = writes().length
  const requestsBefore = requests.length
  await click('button', 'Add 2 new and update 1')
  await waitFor(`document.querySelector('[role=alertdialog]')`, 'confirm')
  assert(writes().length === before, 'imported before confirmation')
  const confirmText = await evaluate(`document.querySelector('[data-testid=import-confirm]').innerText`)
  for (const text of ['New products to add: 2', 'Existing products to modify: 1', 'Unchanged products to skip: 1', 'Duplicate or ambiguous rows (not saved): 3', 'Invalid rows (not saved): 2']) {
    assert(confirmText.includes(text), `confirmation lacks "${text}": ${confirmText}`)
  }
  await click('[role=alertdialog] button', 'Save changes')
  await waitFor(bodyHas('Import finished'), 'summary')
  const made = writes().slice(before)
  const inserted = made.filter((r) => r.method === 'POST').flatMap((r) => (Array.isArray(r.body) ? r.body : [r.body]))
  assert(inserted.map((r) => r.sku).sort().join() === 'IMP-1,IMP-2', 'wrong rows inserted: ' + inserted.map((r) => r.sku).join())
  assert(inserted.find((r) => r.sku === 'IMP-1').category_id === 'c1', 'category not resolved')
  const patches = made.filter((r) => r.method === 'PATCH')
  assert(patches.length === 1, `expected 1 update, got ${patches.length}`)
  assert(patches[0].query.includes('id=eq.p1') && patches[0].query.includes('updated_at=eq.'), 'update not tied to the checked product: ' + patches[0].query)
  assert(JSON.stringify(Object.keys(patches[0].body).sort()) === JSON.stringify(['change_reason', 'selling_price']) && patches[0].body.selling_price === 9950,
    'update is not limited to the changed field: ' + JSON.stringify(patches[0].body))
  assert(!made.some((r) => r.query.includes('p3')), 'the unchanged product was written')
  assert(requests.some((r) => r.path === '/rest/v1/rpc/log_product_import'), 'import not logged')
  assert(!requests.slice(requestsBefore).some((r) => /stock|inventory/.test(r.path)), 'import touched stock')
  assert(await evaluate(bodyHas('2 new products added and 1 existing product updated, of 9 rows')), 'summary text')
  assert(await evaluate(bodyHas('1 unchanged rows skipped · 3 duplicate or ambiguous · 2 failed')), 'skipped / failed counts')
  assert(await evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.includes('Download failed rows'))`), 'no failed-row download')
  await screenshot('08-import-summary')
})

await step('smart import: uploading the same products again creates and updates nothing', async () => {
  await uploadImportFile(xlsxAgainPath)
  const before = writes().length
  await click('button', 'Validate')
  await waitFor(`!!document.querySelector('[data-testid=import-summary]')`, 'preview')
  const counts = [await groupCount('new'), await groupCount('modified'), await groupCount('skipped'), await groupCount('invalid')]
  assert(JSON.stringify(counts) === JSON.stringify([0, 0, 3, 0]), JSON.stringify(counts))
  assert(await evaluate(bodyHas('Nothing to import: every row is unchanged or invalid.')), 'nothing-to-import note')
  assert(await evaluate(`[...document.querySelectorAll('button')].find((b) => b.innerText.includes('Import 0 new'))?.disabled === true`), 'import button not disabled')
  assert(writes().length === before, 'a repeated upload wrote data')
})

await step('import field selection: only the ticked field is updated; near-miss SKUs and names in other capitals are not created', async () => {
  await uploadImportFile(xlsxFieldsPath)
  await waitFor(`!!document.querySelector('[data-testid=modify-fields]')`, 'fields to modify')
  await click('[data-testid=modify-fields] button', 'Deselect All')
  await waitFor(`document.querySelector('[data-testid=modify-count]').innerText.startsWith('0 of')`, 'all deselected')
  await click('[data-testid=modify-field][data-field=selling_price]')
  await waitFor(`document.querySelector('[data-testid=modify-count]').innerText.startsWith('1 of')`, 'one field selected')
  const before = writes().length
  await click('button', 'Validate')
  await waitFor(`!!document.querySelector('[data-testid=import-summary]')`, 'preview')
  const counts = { new: await groupCount('new'), modified: await groupCount('modified'), ambiguous: await groupCount('ambiguous'), invalid: await groupCount('invalid') }
  assert(JSON.stringify(counts) === JSON.stringify({ new: 0, modified: 1, ambiguous: 2, invalid: 0 }), JSON.stringify(counts))
  const fields = await evaluate(`[...document.querySelectorAll('[data-testid=import-comparison][data-sku="MOCK-WC-1"] tbody tr')].map((tr) => tr.dataset.field)`)
  assert(JSON.stringify(fields) === '["selling_price"]', 'only the selected field is compared: ' + JSON.stringify(fields))
  const kept = await evaluate(`document.querySelector('[data-testid=import-comparison][data-sku="MOCK-WC-1"] [data-testid=not-modified]').innerText`)
  assert(kept.includes('Product Name') && kept.includes('GST Rate'), kept)
  for (const text of ['MOCK-WC-1 is almost the same', 'A product with this name already exists (SKU MOCK-CLAY)']) assert(await evaluate(bodyHas(text)), `missing "${text}"`)
  assert(writes().length === before, 'validation wrote data')
  await click('button', 'Add 0 new and update 1')
  await waitFor(`document.querySelector('[role=alertdialog]')`, 'confirm')
  assert((await evaluate(`document.querySelector('[data-testid=import-confirm]').innerText`)).includes('Fields that may change in existing products: Selling Price.'), 'selected fields in the confirmation')
  await click('[role=alertdialog] button', 'Save changes')
  await waitFor(bodyHas('Import finished'), 'summary')
  const made = writes().slice(before)
  assert(!made.some((r) => r.method === 'POST'), 'a product was created: ' + JSON.stringify(made.filter((r) => r.method === 'POST').map((r) => r.body)))
  const patches = made.filter((r) => r.method === 'PATCH')
  assert(patches.length === 1 && JSON.stringify(Object.keys(patches[0].body).sort()) === '["change_reason","selling_price"]' && patches[0].body.selling_price === 9990,
    'update not limited to the selected field: ' + JSON.stringify(patches.map((p) => p.body)))
  assert(patches[0].query.includes('company_id=eq.') && patches[0].query.includes('updated_at=eq.'), 'update not tied to the company and check time: ' + patches[0].query)
})

await step('import match key from ERP Settings: Barcode finds the product, the SKU is selectable and changes only when ticked', async () => {
  ERP_SETTINGS.settings['product.import_match_key'] = 'BARCODE'
  try {
    await uploadImportFile(xlsxBarcodePath)
    await waitFor(`!!document.querySelector('[data-testid=modify-fields]') && !!document.querySelector('[data-testid=match-key]')`, 'fields to modify')
    assert((await evaluate(`document.querySelector('[data-testid=match-key]').innerText`)) === 'Barcode', 'banner does not name the match key')
    const locked = await evaluate(`(() => { const s = document.querySelector('[data-testid=modify-sku]'); return s.dataset.field + '|' + s.disabled + '|' + s.closest('label').innerText })()`)
    assert(locked.startsWith('barcode|true|') && locked.includes('Barcode') && locked.includes('match key (locked)'), locked)
    const sku = `document.querySelector('[data-testid=modify-field][data-field=sku]')`
    assert(await evaluate(`!!${sku} && ${sku}.dataset.state === 'unchecked'`), 'SKU must be selectable and start unticked')
    // Not ticked: the price changes, the SKU does not.
    let before = writes().length
    await click('button', 'Validate')
    await waitFor(`!!document.querySelector('[data-testid=import-summary]')`, 'preview')
    assert((await groupCount('modified')) === 1 && (await groupCount('new')) === 0, 'not matched by barcode')
    assert(await evaluate(bodyHas('the SKU is not changed (not selected)')), 'SKU note missing')
    await click('button', 'Add 0 new and update 1')
    await waitFor(`document.querySelector('[role=alertdialog]')`, 'confirm')
    await click('[role=alertdialog] button', 'Save changes')
    await waitFor(bodyHas('Import finished'), 'summary')
    let patches = writes().slice(before).filter((r) => r.method === 'PATCH')
    assert(patches.length === 1 && patches[0].query.includes('id=eq.p1') && !('sku' in patches[0].body) && patches[0].body.selling_price === 9991,
      'barcode update: ' + JSON.stringify(patches.map((p) => [p.query, p.body])))
    assert(!writes().slice(before).some((r) => r.method === 'POST'), 'a product was created')
    // Ticked: the SKU changes too.
    await uploadImportFile(xlsxBarcodePath)
    await waitFor(`!!${sku}`, 'SKU checkbox')
    await click('[data-testid=modify-field][data-field=sku]')
    await waitFor(`${sku}.dataset.state === 'checked'`, 'SKU ticked')
    before = writes().length
    await click('button', 'Validate')
    await waitFor(`!!document.querySelector('[data-testid=import-summary]')`, 'preview')
    const skuRow = await evaluate(`document.querySelector('[data-testid=import-comparison] tr[data-field=sku]')?.innerText.replace(/\\s+/g, ' ') ?? ''`)
    assert(skuRow.includes('MOCK-WC-1') && skuRow.includes('WC-RENAMED') && skuRow.includes('Update'), skuRow)
    await click('button', 'Add 0 new and update 1')
    await waitFor(`document.querySelector('[role=alertdialog]')`, 'confirm')
    await click('[role=alertdialog] button', 'Save changes')
    await waitFor(bodyHas('Import finished'), 'summary')
    patches = writes().slice(before).filter((r) => r.method === 'PATCH')
    assert(patches.length === 1 && patches[0].body.sku === 'WC-RENAMED', 'SKU not sent when ticked: ' + JSON.stringify(patches.map((p) => p.body)))
    // None: existing products cannot be updated.
    ERP_SETTINGS.settings['product.import_match_key'] = 'NONE'
    await uploadImportFile(xlsxBarcodePath)
    await waitFor(bodyHas('Matching is switched off in ERP Settings'), 'none banner')
    assert(await evaluate(`document.querySelector('input[name=dup-mode][value=update]').disabled && !document.querySelector('[data-testid=modify-fields]')`), 'update still offered with match key None')
  } finally {
    ERP_SETTINGS.settings['product.import_match_key'] = 'SKU'
  }
})

await step('Product Master form: no red mandatory marks; a missing name still shows a message on save', async () => {
  await goto('/products/new')
  await waitFor(`!!document.querySelector('#p-product_name')`, 'form')
  assert(!(await evaluate(`[...document.querySelectorAll('label')].some((l) => l.innerText.includes('*'))`)), 'a form label still has a * mark')
  const nameError = `(document.querySelector('label[for=p-product_name]')?.parentElement?.querySelector('p.text-shortage')?.innerText ?? '')`
  assert((await evaluate(nameError)) === '', 'a message is shown before saving')
  const posts = writes().length
  await click('button[type=submit]')
  await waitFor(`${nameError} !== ''`, 'validation message on save')
  assert(writes().length === posts, 'saved without a name')
})

await step('export downloads the filtered list as CSV', async () => {
  await goto('/products')
  await waitFor(bodyHas('MOCK-WC-1'), 'list')
  await click('button', 'Export')
  await click('[role=menuitem]', 'CSV')
  await waitFor(`${bodyHas('Exported')}`, 'export notice')
  await sleep(800)
  const file = readdirSync(downloadDir).find((f) => f.endsWith('.csv'))
  assert(file, 'no CSV downloaded')
  const csv = readFileSync(path.join(downloadDir, file), 'utf8')
  assert(csv.includes('SKU,Product Name,Category,Product Type,Source Type,Unit,HSN Code,GST Rate,MRP,Selling Price,Cost,Last Purchase Cost,Last Purchase Date,Standard Manufacturing Cost,Minimum Selling Price') && !csv.includes('Standard Purchase Cost'), 'CSV header')
  assert(csv.includes('Lead Time (Days),Reorder Level (Days)') && csv.includes('Supplier Model No.,Supplier Product Name,Length (cm),Width (cm),Height (cm)') && !csv.includes('Minimum Stock Level'), 'CSV planning / supplier columns')
  assert(csv.includes('MOCK-WC-1'), 'CSV rows')
})

// ===========================================================================
// PHASE 4: INVENTORY
// ===========================================================================
async function press(selector, key = 'Enter') {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
  for (const type of ['keyDown', 'keyUp']) {
    await cdp('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : 0 })
  }
  await sleep(300)
}
const rpcCalls = (fn) => requests.filter((r) => r.path === `/rest/v1/rpc/${fn}`)
async function choose(trigger, optionText) {
  await click(trigger)
  await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes(${JSON.stringify(optionText)}))`, `option ${optionText}`)
  await click('[role=option]', optionText)
}

await step('inventory overview separates current position from period movements', async () => {
  await goto('/inventory')
  await waitFor(bodyHas('Current inventory position'), 'overview')
  for (const text of ['Total Active Products', 'Total Units on Hand', 'Total Reserved Units', 'Total Available Units', 'Low-Stock Products',
    'Out-of-Stock Products', 'In-House Stock', 'Outsourced Stock', 'Stock movement trend', 'Awaiting approval', 'Inventory by warehouse']) {
    assert(await evaluate(bodyHas(text)), `missing "${text}"`)
  }
  await screenshot('11-inventory-overview')
})

await step('every inventory page renders for an authorised user', async () => {
  const pages = [
    ['/inventory/stock', 'Stock Register'], ['/inventory/movements', 'TXN-000001'], ['/inventory/warehouses', 'Mock main store'],
    ['/inventory/reservations', 'Stock Reservations'], ['/inventory/alerts', 'Low stock'], ['/inventory/opening-stock', 'OS-000002'],
    ['/inventory/stock/p1', 'Stock by location and lot'],
  ]
  for (const [p, text] of pages) {
    await goto(p)
    await waitFor(bodyHas(text), `${p} shows "${text}"`)
    assert(!(await evaluate(bodyHas("You don't have permission"))), `${p} denied`)
  }
})

await step('stock register: on hand, reserved, available, pending PO, expected incoming, BOM required / shortage, indicators, drill-down and reconciliation', async () => {
  await goto('/inventory/stock')
  await waitFor(bodyHas('MOCK-WC-1') + ' && ' + bodyHasAllCI('On hand', 'Reserved', 'Available', 'Pending PO', 'Expected in', 'BOM required', 'BOM shortage'), 'register rows and columns')
  assert(rpcCalls('inventory_stock_position').length > 0, 'stock position not loaded from the database')
  assert(await evaluate(`!!document.querySelector('[data-indicator="SHORTAGE"]') && !!document.querySelector('[data-indicator="PENDING_PO"]') && !!document.querySelector('[data-indicator="DISCREPANCY"]') && !!document.querySelector('[data-indicator="LOW"]')`),
    'indicators missing')
  await click('button', 'BOM shortage (1)')
  await waitFor(`${bodyHas('MOCK-CLAY')} && !(${bodyHas('MOCK-WC-1')})`, 'BOM shortage filter')
  await click('button', 'All (3)')
  await click('[data-testid=position-row][data-product="MOCK-WC-1"] td:nth-child(3)')
  await waitFor(`!!document.querySelector('[data-testid="position-detail-MOCK-WC-1"]')`, 'drill-down')
  assert(await evaluate(`!!document.querySelector('[data-testid="position-detail-MOCK-WC-1"] a[href="/purchase-orders/po3"]') && !!document.querySelector('[data-testid="position-detail-MOCK-WC-1"] a[href="/goods-receipts/gr1"]') && !!document.querySelector('[data-testid="position-detail-MOCK-WC-1"] a[href="/production/orders/po1"]')`),
    'drill-down lacks PO, GRN or production links')
  assert(await evaluate(bodyHasAll('MAIN / GENERAL', '8 PCS of 10', 'MOCK-CLAY — Mock ceramic body')), 'drill-down lacks the location, pending PO or BOM component')
  assert(rpcCalls('inventory_stock_position_detail').at(-1).body.p_product_id === 'p1', 'detail not loaded for the product')
  await screenshot('12-stock-register-position')
  await click('button', 'Stock reconciliation')
  await waitFor(bodyHasAll('1 discrepancy found', 'MOCK-GLZ', 'Balance differs from the stock ledger'), 'reconciliation dialog')
  await click('[role=dialog] button[aria-label="Close"]')
  await waitFor(`!document.querySelector('[role=dialog]')`, 'reconciliation closed')
  await click('button', 'Excel')
  await click('button', 'By warehouse / location / batch')
  await waitFor(bodyHas('GENERAL'), 'detail rows')
  assert(requests.some((r) => r.path === '/rest/v1/inventory_stock_detail'), 'detail view not queried')
  await screenshot('12-stock-register-detail')
})

await step('Stock Register product rows: photo first (uploaded before link, placeholder, broken link), no arrow, whole row expands and collapses, sorting, search, pagination keeps images, one image query per page', async () => {
  const [p1, , p3, p4] = products
  const saved = [p1, p3, p4].map((p) => ({ image_url: p.image_url ?? null, product_image_path: p.product_image_path ?? null }))
  const LINK = 'https://img.smoke.example/clay.png'
  Object.assign(p1, { product_image_path: `${COMPANY_ID}/p1/basin.png`, image_url: 'https://img.smoke.example/broken-not-used.jpg' })
  Object.assign(p3, { image_url: LINK })
  Object.assign(p4, { image_url: 'https://img.smoke.example/broken-glaze.jpg' })
  STOCK_POSITION_EXTRA = 30
  const row = (sku) => `document.querySelector('[data-testid=position-row][data-product="${sku}"]')`
  const thumb = (sku) => `${row(sku)}?.querySelector('[data-testid=product-thumb]')`
  const loaded = (sku) => `(() => { const i = ${thumb(sku)}?.querySelector('img'); return !!i && i.complete && i.naturalWidth > 0 })()`
  const imageQueries = () => requests.filter((r) => r.path === '/rest/v1/products' && r.query.includes('product_image_path') && r.query.includes('id=in.'))
  const detail = (sku) => `!!document.querySelector('[data-testid="position-detail-${sku}"]')`
  try {
    const before = imageQueries().length
    await goto('/inventory/stock')
    await waitFor(`!!${row('MOCK-WC-1')} && !!${row('MOCK-X01')}`, 'register rows')
    // 1. Uploaded image wins over the link.  2. Link when nothing is uploaded.  3. No image.  4. Broken link.
    await waitFor(loaded('MOCK-WC-1'), 'uploaded image shown')
    assert(await evaluate(`${thumb('MOCK-WC-1')}.querySelector('img').src.includes('/storage/v1/object/sign/product-images/')`), 'the link was used instead of the uploaded image')
    await waitFor(`${loaded('MOCK-CLAY')} && ${thumb('MOCK-CLAY')}.querySelector('img').src === ${JSON.stringify(LINK)}`, 'image link shown')
    await waitFor(`${thumb('MOCK-GLZ')}?.dataset.state === 'broken' && !!${thumb('MOCK-GLZ')}.querySelector('[data-testid=product-thumb-placeholder]')`, 'broken link placeholder')
    assert(await evaluate(`${thumb('MOCK-X01')}?.dataset.state === 'none'`), 'no-image placeholder')
    // Photo is the first cell; 48 px square, contained, lazy; no arrow anywhere in the rows.
    assert(await evaluate(`${row('MOCK-WC-1')}.querySelector('td').querySelector('[data-testid=product-thumb]') !== null`), 'image not in the first cell')
    assert(await evaluate(`(() => { const r = ${thumb('MOCK-CLAY')}.getBoundingClientRect(); const i = ${thumb('MOCK-CLAY')}.querySelector('img'); return r.width === 48 && r.height === 48 && getComputedStyle(i).objectFit === 'contain' && i.loading === 'lazy' })()`), 'thumbnail size / fit / lazy')
    assert(await evaluate(`!document.querySelector('[data-testid=position-row] svg.lucide-chevron-right, [data-testid=position-row] svg.lucide-chevron-down') && !document.querySelector('button[aria-label^="Show details of"]')`), 'an expand arrow is still shown')
    const heads = await evaluate(`[...document.querySelector('[data-testid=position-row]').closest('table').querySelectorAll('thead th')].map((t) => t.innerText.trim().toLowerCase())`)
    assert(JSON.stringify(heads.slice(0, 8)) === JSON.stringify(['image', 'product', 'category', 'unit', 'on hand', 'reserved', 'available', 'stock status']), JSON.stringify(heads))
    // 10. One batched image query for the page (25 rows), not one per row.
    assert(imageQueries().length - before === 1, `image queries for one page: ${imageQueries().length - before}`)
    await screenshot('190-stock-register-photos')
    // 5, 6. Clicking anywhere on the row opens it; again closes it. The page stays on the Stock Register.
    await click(`[data-testid=position-row][data-product="MOCK-WC-1"] td:nth-child(5)`)
    await waitFor(detail('MOCK-WC-1'), 'row expanded')
    assert(await evaluate(`location.pathname === '/inventory/stock' && ${row('MOCK-WC-1')}.getAttribute('aria-expanded') === 'true'`), 'navigated away or not marked expanded')
    // 7. Existing details unchanged.
    assert(await evaluate(bodyHasAll('MAIN / GENERAL', '8 PCS of 10')), 'expanded details changed')
    await click(`[data-testid=position-row][data-product="MOCK-WC-1"] td:nth-child(1)`)
    await waitFor(`!${detail('MOCK-WC-1')}`, 'row collapsed by clicking the photo cell')
    // Keyboard: Enter on the focused row.
    await evaluate(`(() => { const r = ${row('MOCK-CLAY')}; r.focus(); r.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`)
    await waitFor(detail('MOCK-CLAY'), 'keyboard opens the row')
    await click(`[data-testid=position-row][data-product="MOCK-CLAY"] td:nth-child(3)`)
    await waitFor(`!${detail('MOCK-CLAY')}`, 'collapsed')
    // 8. Sorting keeps each photo with its product.
    await click('th button', 'ON HAND')
    await waitFor(`document.querySelector('[data-testid=position-row]')?.dataset.product === 'MOCK-X01'`, 'sorted by on hand')
    // MOCK-WC-1 and MOCK-CLAY are now on page 2; the photos on page 1 still belong to their own products.
    assert(await evaluate(`${thumb('MOCK-GLZ')}?.dataset.state === 'broken' && ${thumb('MOCK-X05')}?.dataset.state === 'none'`), 'photo moved to another product after sorting')
    await click('th button', 'PRODUCT')
    await waitFor(`document.querySelector('[data-testid=position-row]')?.dataset.product === 'MOCK-CLAY'`, 'sorted by product')
    // 9. Next page: its own photos (one more batched query); back again: the first page's photos are still there.
    const beforePage = imageQueries().length
    await click('button[aria-label="Next page"]')
    await waitFor(`!${row('MOCK-WC-1')} && !!document.querySelector('[data-testid=position-row] [data-testid=product-thumb]')`, 'page 2 with placeholders')
    for (let t = Date.now(); imageQueries().length === beforePage && Date.now() - t < 3000;) await sleep(100)
    assert(imageQueries().length - beforePage === 1, `image queries for page 2: ${imageQueries().length - beforePage}`)
    await click('button[aria-label="Previous page"]')
    await waitFor(`${loaded('MOCK-WC-1')} && ${loaded('MOCK-CLAY')}`, 'photos visible again on page 1')
    // Search still filters the register.
    await fill('input[placeholder^="Search or scan SKU"]', 'clay')
    for (let t = Date.now(); !rpcCalls('inventory_stock_position').some((c) => JSON.stringify(c.body.p_filters ?? {}).toLowerCase().includes('clay')) && Date.now() - t < 4000;) await sleep(100)
    assert(rpcCalls('inventory_stock_position').some((c) => JSON.stringify(c.body.p_filters ?? {}).toLowerCase().includes('clay')), 'search not sent with the register query')
    await fill('input[placeholder^="Search or scan SKU"]', '')
  } finally {
    STOCK_POSITION_EXTRA = 0
    ;[p1, p3, p4].forEach((p, i) => Object.assign(p, saved[i]))
  }
})

await step('receipt: barcode scan selects product; review step; one posting with a request id', async () => {
  await goto('/inventory/movements')
  await waitFor(bodyHas('TXN-000001'), 'movements')
  await click('button', 'Receive')
  await waitFor(`document.querySelector('#rc-product')`, 'receipt dialog')
  await fill('#rc-product', '8901234567890')
  await press('#rc-product')
  await waitFor(bodyHas('Mock Closet 1'), 'product chosen by barcode')
  await choose('#rc-source', 'In-House')
  await fill('#rc-qty', '5')
  await click('[role=dialog] button', 'Review')
  await waitFor(bodyHas('Review: Receive stock'), 'review step')
  assert(rpcCalls('inventory_post_receipt').length === 0, 'posted before confirmation')
  await screenshot('13-receipt-review')
  await click('[role=dialog] button', 'Post')
  await waitFor(bodyHas('Posted TXN-000009'), 'success only after RPC')
  const calls = rpcCalls('inventory_post_receipt')
  assert(calls.length === 1, `expected 1 posting, got ${calls.length}`)
  const b = calls[0].body
  assert(/^[0-9a-f-]{36}$/.test(b.p_idempotency_key), 'no idempotency key')
  assert(b.p_product_id === 'p1' && b.p_location_id === 'l1' && b.p_quantity === 5 && b.p_source_type === 'IN_HOUSE' && b.p_unit_cost === null, JSON.stringify(b))
})

await step('opening stock: no source field; add, review, edit and remove lines; incomplete lines explained; existing balances caught; draft survives refresh; one submission', async () => {
  const reviewBtn = `document.querySelector('[data-testid=opening-review]')`
  const lineCount = `document.querySelectorAll('[data-testid=opening-line]').length`
  const pickProduct = async (term, sku) => {
    await fill('#os-product', term)
    // Let the debounced search (250 ms) replace any earlier result list before clicking (the click is by position).
    await sleep(500)
    await waitFor(`!document.querySelector('[role=listbox]')?.innerText.includes('Searching') && [...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes(${JSON.stringify(sku)}))`, `search results for ${sku}`)
    await click('[role=option]', sku)
  }
  const openEntry = async () => {
    await goto('/inventory/opening-stock')
    await waitFor(bodyHas('OS-000002'), 'opening list')
    await click('button', 'Enter opening stock')
    await waitFor(`document.querySelector('#os-product') || document.querySelector('[data-testid=opening-confirm]')`, 'entry dialog')
    await waitFor(`document.querySelector('[role=dialog] [data-draft-status]')?.dataset.draftStatus !== 'loading'`, 'draft check')
  }
  const existingLine = { id: 'osl-existing', company_id: COMPANY_ID, opening_batch_id: 'ob2', line_no: 1, product_id: 'p3', warehouse_id: 'w1', location_id: 'l1',
    source_type: 'UNKNOWN', batch_number: null, quantity: 4, unit_cost: null, effective_date: TODAY, status: 'PENDING_APPROVAL' }
  try {
    await openEntry()
    // 4. No "Actual source" dropdown; the fields are in the requested order.
    const labels = await evaluate(`[...document.querySelectorAll('[role=dialog] label')].map((l) => l.innerText.trim())`)
    assert(!(await evaluate(`!!document.querySelector('#os-src')`)) && !labels.some((l) => /source/i.test(l)) && !(await evaluate(`/actual source/i.test(document.querySelector('[role=dialog]').innerText)`)), 'source field still shown: ' + JSON.stringify(labels))
    const want = ['Product', 'Warehouse / location', 'Quantity', 'Unit cost (₹, Product Master Cost, optional)', 'Opening stock value', 'Effective date', 'Reference (optional, e.g. count sheet no.)']
    assert(JSON.stringify(labels) === JSON.stringify(want), JSON.stringify(labels))
    assert(await evaluate(`${reviewBtn}.disabled && ${reviewBtn}.innerText.includes('Review 0 line(s)')`), 'Review must be disabled with no lines')
    await screenshot('170-opening-entry-no-source')

    // 8. An incomplete line is explained next to the buttons, not ignored.
    await pickProduct('MOCK', 'MOCK-WC-1')
    assert(await evaluate(`!${reviewBtn}.disabled`), 'Review should respond once a line is being entered')
    await click('[data-testid=opening-review]')
    await waitFor(`document.querySelector('[data-testid=opening-entry-error]')?.innerText.includes('Enter the quantity')`, 'incomplete line explained')
    assert(await evaluate(`!!document.querySelector('#os-qty') && ${lineCount} === 0`), 'left the entry step')
    await fill('#os-qty', '0')
    await click('[role=dialog] button', 'Add line')
    await waitFor(`document.querySelector('[data-testid=opening-entry-error]')?.innerText.includes('greater than zero')`, 'zero quantity explained')

    // 5. One line is added.
    await fill('#os-qty', '7')
    // 1. The Product Master Cost is fetched for the product and shown read-only; value = quantity × cost.
    await waitFor(`document.querySelector('#os-cost')?.value === '850' && document.querySelector('#os-cost').readOnly`, 'Product Master Cost filled, read-only')
    assert(rpcCalls('opening_stock_product_costs').some((c) => JSON.stringify(c.body.p_product_ids) === '["p1"]'), 'cost not fetched from the database')
    await waitFor(`document.querySelector('#os-value')?.value === '₹5,950.00'`, 'opening value 7 × ₹850')
    assert(!(await evaluate(`!!document.querySelector('[data-testid=os-cost-override]')`)), 'override offered without permission')
    await fill('#os-ref', 'CS-17')
    await waitFor(`${reviewBtn}.innerText.includes('Review 1 line(s)')`, 'count includes the completed line being typed')
    await click('[role=dialog] button', 'Add line')
    await waitFor(`${lineCount} === 1 && !document.querySelector('[data-testid=opening-entry-error]')`, 'line added')
    assert(await evaluate(`document.querySelector('[data-testid=opening-line]').innerText.includes('CS-17')`), 'reference not shown on the line')
    // The same product, location and batch twice is refused.
    await pickProduct('MOCK', 'MOCK-WC-1')
    await fill('#os-qty', '1')
    await click('[role=dialog] button', 'Add line')
    await waitFor(`document.querySelector('[data-testid=opening-entry-error]')?.innerText.includes('already in the list')`, 'duplicate in the list refused')
    // 5. A product without a Product Master Cost is accepted with a pending cost (cost optional, 20261204090000).
    await click('[role=dialog] button[aria-label="Change product"]')
    await waitFor(`document.querySelector('#os-product')?.tagName === 'INPUT'`, 'product cleared')
    await pickProduct('GLZ', 'MOCK-GLZ')
    await waitFor(`document.querySelector('[data-testid=os-cost-missing]')?.innerText.includes('pending cost') && document.querySelector('#os-cost').value === ''`, 'no cost: pending, field blank')
    await fill('#os-batch', 'B-1')
    await click('[role=dialog] button', 'Add line')
    await waitFor(`${lineCount} === 2 && !document.querySelector('[data-testid=opening-entry-error]')`, 'line without a cost added')
    assert(await evaluate(`(() => { const l = [...document.querySelectorAll('[data-testid=opening-line]')][1]; return l.querySelector('[data-testid=opening-line-cost]').innerText.includes('Pending cost') && l.querySelector('[data-testid=opening-line-value]').innerText.includes('Not valued') })()`), 'pending cost line')
    await click('[role=dialog] button[aria-label="Remove line 2"]')
    await waitFor(`${lineCount} === 1`, 'line removed again')

    // 6, 7. A second product typed but not added: Review takes it and opens the review screen.
    // (Adding the line above cleared the product; clear it here only if one is still selected.)
    if (await evaluate(`!!document.querySelector('[role=dialog] button[aria-label="Change product"]')`)) await click('[role=dialog] button[aria-label="Change product"]')
    await waitFor(`document.querySelector('#os-product')?.tagName === 'INPUT'`, 'product cleared')
    await fill('#os-qty', '')
    await pickProduct('CLAY', 'MOCK-CLAY')
    await fill('#os-qty', '2.5')
    await waitFor(`${reviewBtn}.innerText.includes('Review 2 line(s)')`, 'two lines counted')
    await click('[data-testid=opening-review]')
    await waitFor(`!!document.querySelector('[data-testid=opening-confirm]') && ${lineCount} === 2`, 'review screen with both lines')
    const costs = await evaluate(`[...document.querySelectorAll('[data-testid=opening-line-cost]')].map((c) => c.innerText.trim())`)
    const values = await evaluate(`[...document.querySelectorAll('[data-testid=opening-line-value]')].map((c) => c.innerText.trim())`)
    assert(JSON.stringify(costs) === '["₹850.00","₹42.50"]' && JSON.stringify(values) === '["₹5,950.00","₹106.25"]', JSON.stringify([costs, values]))
    assert(!(await evaluate(`/source|in-house|outsourced/i.test(document.querySelector('[data-testid=opening-lines]').innerText)`)), 'source shown on the review screen')
    await screenshot('171-opening-review')

    // 9. Remove and edit from the review screen; entered lines are kept.
    await click('[aria-label="Remove line 2"]')
    await waitFor(`${lineCount} === 1 && !!document.querySelector('[data-testid=opening-confirm]')`, 'line removed on review')
    await click('[aria-label="Edit line 1"]')
    await waitFor(`document.querySelector('#os-qty')?.value === '7' && document.querySelector('#os-cost').value === '850' && document.querySelector('#os-ref').value === 'CS-17' && ${lineCount} === 0`, 'line back in the form for editing')
    await fill('#os-qty', '8')
    await click('[role=dialog] button', 'Add line')
    await pickProduct('CLAY', 'MOCK-CLAY')
    await fill('#os-qty', '2.5')
    await click('[role=dialog] button', 'Add line')
    await waitFor(`${lineCount} === 2`, 'two lines again')

    // An opening balance already recorded for that product and location (with any source) is caught before review.
    tables.inventory_opening_lines.push(existingLine)
    await click('[data-testid=opening-review]')
    await waitFor(`document.querySelector('[data-testid=opening-line-error]')?.innerText.includes('already exists (OS-000002)')`, 'existing opening balance caught')
    assert(await evaluate(`!document.querySelector('[data-testid=opening-confirm]') && document.querySelector('[data-testid=opening-entry-error]').innerText.includes('1 line(s) cannot be recorded')`), 'went on to review')
    await click('[aria-label="Remove line 2"]')
    await click('[data-testid=opening-review]')
    await waitFor(`!!document.querySelector('[data-testid=opening-confirm]')`, 'review after removing the problem line')

    // 11. Refreshing keeps the draft, including the review step and its lines.
    await waitFor(`document.querySelector('[role=dialog] [data-draft-status]')?.dataset.draftStatus === 'saved'`, 'draft saved', 8000)
    await cdp('Page.reload')
    await sleep(300)
    await openEntry()
    await waitFor(`!!document.querySelector('[data-testid=opening-confirm]') && ${lineCount} === 1 && document.querySelector('[data-testid=opening-line]').innerText.includes('MOCK-WC-1')`, 'draft restored after refresh')

    // 10. Confirming sends the right quantities once, with the source derived from the product, never UNKNOWN.
    const before = rpcCalls('inventory_submit_opening_stock_at_cost').length
    await evaluate(`(() => { const b = document.querySelector('[data-testid=opening-confirm]'); b.click(); b.click() })()`)
    await waitFor(bodyHas('OS-000009 submitted'), 'submitted')
    await sleep(300)
    const calls = rpcCalls('inventory_submit_opening_stock_at_cost').slice(before)
    assert(rpcCalls('inventory_submit_opening_stock').length === 0, 'the old submission without server-side pricing was used')
    assert(calls.length === 1, `double click sent ${calls.length} submissions`)
    const b = calls[0].body
    assert(b.p_source === 'MANUAL' && b.p_lines.length === 1 && /^[0-9a-f-]{36}$/.test(b.p_idempotency_key), JSON.stringify(b))
    const l = b.p_lines[0]
    assert(l.product_id === 'p1' && l.quantity === 8 && l.source_type === 'IN_HOUSE' && l.unit_cost === null && !('cost_override' in l) && l.location_id === 'l1' && l.reference === 'CS-17' && l.effective_date === TODAY, JSON.stringify(l))
    assert(!requests.some((r) => r.path.includes('review_opening')), 'auto-approved')
    // 12. Entering opening stock posts nothing else: no other stock workflow was called.
    assert(!requests.slice(-60).some((r) => /goods_receipt|production|transfer|adjustment/.test(r.path) && r.method !== 'GET'), 'another stock workflow was called')
  } finally {
    const i = tables.inventory_opening_lines.indexOf(existingLine)
    if (i >= 0) tables.inventory_opening_lines.splice(i, 1)
  }
})

const csvPath = path.join(outDir, 'opening-test.csv')
writeFileSync(csvPath, 'SKU,Warehouse,Location,Source,Qty,Unit Cost\nMOCK-WC-1,MAIN,BIN-1,In House,3,450\nNOPE-1,MAIN,,In House,2,\nMOCK-WC-1,MAIN,BIN-1,Factory,1,\n')
const csvNoSource = path.join(outDir, 'opening-test-no-source.csv')
writeFileSync(csvNoSource, 'SKU,Warehouse,Location,Quantity,Unit Cost,Reference\nMOCK-WC-1,MAIN,BIN-1,3,450,CS-1\n')

await step('opening stock import: no Source mapping; an old Source column is ignored; rejected rows listed, only accepted rows staged', async () => {
  const upload = async (file) => {
    await goto('/inventory/opening-stock/import')
    await waitFor(`document.querySelector('input[type=file]')`, 'upload')
    const { root: doc } = await cdp('DOM.getDocument')
    const { nodeId } = await cdp('DOM.querySelector', { nodeId: doc.nodeId, selector: 'input[type=file]' })
    await cdp('DOM.setFileInputFiles', { nodeId, files: [file] })
    await waitFor(bodyHas('Column mapping'), 'mapping')
  }
  const mappingLabels = `[...document.querySelectorAll('label[for^=om-]')].map((l) => l.innerText.replace('*', '').trim())`
  // 1, 3. A file without a Source column maps with nothing missing, and the mapping screen has no Source field.
  await upload(csvNoSource)
  const labels = await evaluate(mappingLabels)
  assert(!labels.some((l) => /cost/i.test(l)), 'a cost field is offered in the mapping: ' + JSON.stringify(labels))
  assert(!labels.includes('Source') && !(await evaluate(`!!document.querySelector('#om-source')`)), 'Source still in the mapping: ' + JSON.stringify(labels))
  assert(JSON.stringify(await evaluate(`[...document.querySelectorAll('label[for^=om-]')].filter((l) => l.innerText.includes('*')).map((l) => l.innerText.replace('*', '').trim())`)) === '["SKU","Warehouse","Quantity"]', 'required fields')
  assert(!(await evaluate(bodyHas('Map the required fields'))), 'a required field is missing for a file without Source')
  await click('button', 'Validate rows')
  await waitFor(bodyHas('Row results'), 'review')
  assert(await evaluate(`[...document.querySelectorAll('th')].every((th) => th.innerText.trim() !== 'Source')`), 'Source column in the preview')
  assert(await evaluate(bodyHas('Stage 1 accepted row(s) for approval')), 'file without Source not accepted')

  // 2. An older file with a Source column: the column is ignored (an unrecognised value no longer rejects the row).
  await upload(csvPath)
  assert(await evaluate(`document.querySelector('[data-testid=source-ignored]')?.innerText.includes('"Source" is not used')`), 'ignored-column note')
  assert(!(await evaluate(`[...document.querySelectorAll('[id^=om-] span')].some((s) => s.innerText.trim() === 'Source')`)), 'Source column mapped to a field')
  const before = rpcCalls('inventory_submit_opening_stock_at_cost').length
  // 3. The Unit Cost column (₹450) is ignored: the cost is the Product Master Cost (₹850).
  assert(await evaluate(`document.querySelector('[data-testid=cost-ignored]')?.innerText.includes('"Unit Cost" is ignored')`), 'ignored cost column note')
  assert(!(await evaluate(`!!document.querySelector('#om-unit_cost')`)), 'a unit cost field is still mapped')
  await click('button', 'Validate rows')
  await waitFor(bodyHas('Row results'), 'review')
  for (const text of ['SKU "NOPE-1" was not found', 'Duplicate of row 2']) assert(await evaluate(bodyHas(text)), `missing "${text}"`)
  assert(!(await evaluate(bodyHas('is not recognised'))), 'the Source value was still validated')
  assert(rpcCalls('inventory_submit_opening_stock_at_cost').length === before, 'validation wrote data')
  const heads = await evaluate(`[...document.querySelectorAll('th')].map((th) => th.innerText.trim().toLowerCase())`)
  for (const h of ['product code', 'product name', 'opening quantity', 'product master cost', 'opening stock value', 'validation status']) assert(heads.includes(h), `preview column ${h}: ${heads}`)
  assert(await evaluate(`[...document.querySelectorAll('tbody tr')].some((r) => r.innerText.includes('MOCK-WC-1') && r.querySelector('[data-testid=oi-cost]')?.innerText === '₹850.00'
    && r.querySelector('[data-testid=oi-value]')?.innerText === '₹2,550.00' && r.innerText.includes('Mock Closet 1'))`), 'preview cost / value')
  assert(rpcCalls('opening_stock_product_costs').length > 0, 'costs not fetched from the database')
  await screenshot('14-opening-import-review')
  await click('button', 'Stage 1 accepted row(s) for approval')
  await waitFor(`document.querySelector('[role=alertdialog]')`, 'confirm')
  await click('[role=alertdialog] button', 'Stage for approval')
  await waitFor(bodyHas('OS-000009 staged'), 'staged')
  const b = rpcCalls('inventory_submit_opening_stock_at_cost').at(-1).body
  assert(b.p_source === 'IMPORT' && b.p_lines.length === 1 && b.p_lines[0].line_no === 2 && b.p_lines[0].location_id === 'l2' && b.p_lines[0].source_type === 'IN_HOUSE'
    && b.p_lines[0].unit_cost === null, JSON.stringify(b))
})

await step('Opening stock import: existing records matched and quantity ADDED (100 + 25 + 5 = 130 PCS), fields to modify, comparison, totals per unit', async () => {
  OPENING_ADDITIVE = true
  SMOKE_SOD = false
  try {
    const file = path.join(outDir, 'opening-additive.csv')
    writeFileSync(file, 'SKU,Warehouse,Location,Quantity,Unit Cost,Notes\nMOCK-WC-1,MAIN,BIN-1,25,999,count A\nMOCK-WC-1,MAIN,BIN-1,5,,\nMOCK-CLAY,MAIN,BIN-1,2.5,,\n')
    const upload = async () => {
      await goto('/inventory/opening-stock/import')
      await waitFor(`document.querySelector('input[type=file]')`, 'upload')
      const { root: doc } = await cdp('DOM.getDocument')
      const { nodeId } = await cdp('DOM.querySelector', { nodeId: doc.nodeId, selector: 'input[type=file]' })
      await cdp('DOM.setFileInputFiles', { nodeId, files: [file] })
      await waitFor(`!!document.querySelector('[data-testid=oi-fields]')`, 'fields to modify')
    }
    await upload()
    const state = (k) => `document.querySelector('#oi-field-${k}')?.getAttribute('data-state')`
    const count = `document.querySelector('[data-testid=oi-fields-count]')?.innerText`
    assert(await evaluate(`${state('quantity')} === 'checked' && ${state('unit_cost')} === 'unchecked' && ${state('remarks')} === 'unchecked' && ${count} === '1 of 3 selected'`), 'defaults: Quantity only')
    assert(await evaluate(`document.querySelector('#oi-field-expiry')?.disabled === true && ${bodyHas('Not supported: the dates of an existing batch are fixed')}`), 'expiry not supported, explained')
    assert(await evaluate(bodyHas('Blank Excel cells never erase existing data')), 'blank cells note')
    await click('button', 'Deselect All')
    await waitFor(`${count} === '0 of 3 selected'`, 'deselect all')
    await click('button', 'Select All')
    await waitFor(`${count} === '3 of 3 selected'`, 'select all')
    await click('#oi-field-unit_cost')
    await click('#oi-field-remarks')
    await waitFor(`${count} === '1 of 3 selected' && ${state('quantity')} === 'checked'`, 'back to Quantity only')
    await click('button', 'Validate rows')
    await waitFor(`!!document.querySelector('[data-testid=oi-totals]')`, 'preview')
    const kpi = (id) => `document.querySelector('[data-testid=oi-kpi-${id}]')?.innerText`
    await waitFor(`${kpi('new')}.includes('1') && ${kpi('matched')}.includes('2') && ${kpi('adding')}.includes('2') && ${kpi('qty')}.includes('30 PCS') && ${kpi('qty')}.includes('2.5 KG')`, 'totals per unit')
    const cmp = `[...document.querySelectorAll('[data-testid=oi-compare]')].map((t) => t.innerText)`
    const tables = await evaluate(cmp)
    assert(tables.length === 2 && /Quantity\s+100 PCS\s+25 PCS\s+Add → 125 PCS/.test(tables[0]) && /Quantity\s+125 PCS\s+5 PCS\s+Add → 130 PCS/.test(tables[1])
      && /Unit Cost\s+₹850\.00\s+—\s+Not selected: keep/.test(tables[0]) && /Product\s+MOCK-WC-1\s+MOCK-WC-1\s+Keep/.test(tables[0]) && /Location\s+MAIN\/BIN-1\s+MAIN\/BIN-1\s+Keep/.test(tables[0]), JSON.stringify(tables))
    assert(await evaluate(`[...document.querySelectorAll('[data-testid=oi-action]')].map((a) => a.innerText).join('|') === 'Add to OS-000003 → 125 PCS|Add to OS-000003 → 130 PCS|New record'`), 'import action column')
    assert(!(await evaluate(bodyHas('already exists'))), 'an existing record was rejected')
    await screenshot('206-opening-import-additive')
    await click('button', 'Post 3 accepted row(s)')
    await waitFor(`document.querySelector('[role=alertdialog]')`, 'confirm')
    assert(await evaluate(`document.querySelector('[role=alertdialog]').innerText.includes('2 row(s) add their quantity to existing opening stock (never replacing it)')`), 'confirm text')
    await click('[role=alertdialog] button', 'Post opening stock')
    await waitFor(`document.querySelector('[data-testid=oi-done]')?.innerText.includes('OS-000010 posted with 1 new line(s). Quantity added to existing opening stock on 2 row(s).')`, 'posted')
    const b = rpcCalls('inventory_import_opening_stock').at(-1).body
    assert(JSON.stringify(b.p_fields) === '{"quantity":true,"unit_cost":false,"remarks":false}' && b.p_post === true && b.p_lines.length === 3
      && b.p_lines.every((l) => l.unit_cost === null) && b.p_lines.map((l) => l.quantity).join() === '25,5,2.5', JSON.stringify(b))

    // Unit Cost selected: ₹999 differs from the existing ₹850 and is refused with the row; the blank cell is fine.
    await upload()
    await click('#oi-field-unit_cost')
    await waitFor(`${state('unit_cost')} === 'checked'`, 'unit cost selected')
    assert(await evaluate(bodyHas('Read from column "Unit Cost"')), 'cost column named')
    await click('button', 'Validate rows')
    await waitFor(bodyHas('Unit cost 999 differs from the cost of the existing stock in OS-000003 (850)'), 'different cost refused')
    assert(await evaluate(`${kpi('adding')}.includes('1')`), 'only the valid row adds')
  } finally {
    OPENING_ADDITIVE = false
    SMOKE_SOD = true
  }
})

await step('Opening stock cost override: OFF by default; a settings manager switches it on in ERP Settings; the override is then offered, editable and sent flagged', async () => {
  try {
    await goto('/admin/erp-settings?tab=inventory')
    await waitFor(`!!document.querySelector('[data-testid=opening-cost-settings] [data-testid=es-opening-override]')`, 'override setting')
    assert(await evaluate(`document.querySelector('[data-testid=es-opening-override]').getAttribute('data-state') === 'unchecked' && !document.querySelector('[data-testid=es-opening-override]').disabled`), 'default OFF / editable for a settings manager')
    assert(await evaluate(bodyHas('Every override is recorded in the audit log')), 'audit note')
    await screenshot('195-opening-cost-override-setting')
    await click('[data-testid=es-opening-override]')
    await click('button', 'Save settings')
    await waitFor(bodyHas('Settings saved and recorded in the audit log.'), 'saved')
    assert(rpcCalls('erp_settings_save').at(-1).body.p_settings['inventory.opening_cost_override'] === true, JSON.stringify(rpcCalls('erp_settings_save').at(-1).body))
    // The manual entry now offers the override for this user.
    await goto('/inventory/opening-stock')
    await waitFor(bodyHas('OS-000002'), 'opening list')
    await click('button', 'Enter opening stock')
    await waitFor(`!!document.querySelector('#os-product')`, 'entry dialog')
    await fill('#os-product', 'CLAY')
    await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('MOCK-CLAY'))`, 'clay option')
    await click('[role=option]', 'MOCK-CLAY')
    await waitFor(`document.querySelector('#os-cost')?.value === '42.5' && !!document.querySelector('[data-testid=os-cost-override]')`, 'override offered')
    assert(await evaluate(`document.querySelector('#os-cost').readOnly`), 'cost editable before choosing the override')
    await click('[data-testid=os-cost-override] input')
    await waitFor(`!document.querySelector('#os-cost').readOnly`, 'cost editable with the override')
    await fill('#os-cost', '45')
    await fill('#os-qty', '2')
    await waitFor(`document.querySelector('#os-value')?.value === '₹90.00'`, 'value with the override cost')
    await click('[role=dialog] button', 'Add line')
    await waitFor(`document.querySelector('[data-testid=opening-line-cost]')?.innerText.includes('override')`, 'override marked on the line')
    await click('[data-testid=opening-review]')
    await waitFor(`!!document.querySelector('[data-testid=opening-confirm]')`, 'review')
    const before = rpcCalls('inventory_submit_opening_stock_at_cost').length
    await click('[data-testid=opening-confirm]')
    await waitFor(`${rpcCalls('inventory_submit_opening_stock_at_cost').length} > ${before} || ${bodyHas('submitted')}`, 'submitted')
    for (let t = Date.now(); rpcCalls('inventory_submit_opening_stock_at_cost').length === before && Date.now() - t < 3000;) await sleep(100)
    const l = rpcCalls('inventory_submit_opening_stock_at_cost').at(-1).body.p_lines[0]
    assert(l.cost_override === true && l.unit_cost === 45 && l.product_id === 'p3', JSON.stringify(l))
    assert(rpcCalls('inventory_submit_opening_stock').length === 0 && rpcCalls('inventory_post_opening_stock').length === 0, 'an older opening stock function was called')
  } finally {
    ERP_SETTINGS.settings['inventory.opening_cost_override'] = false
  }
})

await step('Stock Adjustments (restored): sidebar entry, totals and filters, detail with before / after, reason and attachments, segregation of duties, new adjustment form', async () => {
  SERVE_PREFERENCES = true
  try {
  await goto('/inventory/adjustments')
  await waitFor(`!!document.querySelector('[data-testid=adj-kpi-pending]') && ${bodyHas('ADJ-000001')}`, 'adjustments page')
  // Sidebar: under Inventory Management, active.
  assert(await evaluate(`[...document.querySelectorAll('aside a')].some((a) => a.getAttribute('href') === '/inventory/adjustments' && a.innerText.includes('Stock Adjustments') && (a.getAttribute('aria-current') === 'page' || a.className.includes('bg-')))`), 'sidebar entry not active')
  // Totals of the list: one pending, nothing posted.
  assert((await evaluate(`document.querySelector('[data-testid=adj-kpi-pending]').innerText`)).includes('1'), 'pending total')
  assert((await evaluate(`document.querySelector('[data-testid=adj-kpi-completed]').innerText`)).includes('0'), 'completed total')
  // The row: system stock 100, physical 98, adjustment −2, reason from ERP Settings.
  const row = await evaluate(`[...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes('ADJ-000001'))?.innerText ?? ''`)
  for (const t of ['MOCK-WC-1', '100', '98', '-2', 'Damaged']) assert(row.includes(t), `row lacks ${t}: ${row}`)
  // Filters go to the database query.
  await choose('#af-status', 'Pending approval')
  for (let t = Date.now(); !requests.some((r) => r.path === '/rest/v1/inventory_adjustments' && r.query.includes('status=eq.PENDING_APPROVAL')) && Date.now() - t < 3000;) await sleep(100)
  assert(requests.some((r) => r.path === '/rest/v1/inventory_adjustments' && r.query.includes('status=eq.PENDING_APPROVAL')), 'status filter not sent')
  await choose('#af-reason', 'Damaged')
  for (let t = Date.now(); !requests.some((r) => r.path === '/rest/v1/inventory_adjustments' && r.query.includes('reason_label=eq.Damaged')) && Date.now() - t < 3000;) await sleep(100)
  assert(requests.some((r) => r.path === '/rest/v1/inventory_adjustments' && r.query.includes('reason_label=eq.Damaged')), 'reason filter not sent')
  await screenshot('196-stock-adjustments')
  // Detail: before / after, reason, attachments; own request with segregation of duties ON → no approve button.
  await click('button[aria-label="Open ADJ-000001"]')
  await waitFor(`!!document.querySelector('[data-testid=adj-detail]')`, 'detail')
  assert((await evaluate(`document.querySelector('[data-testid=adj-before]').innerText`)).includes('100'), 'before quantity')
  assert((await evaluate(`document.querySelector('[data-testid=adj-after]').innerText`)).includes('98'), 'after quantity')
  assert(await evaluate(bodyHasAll('Supporting attachments', 'Damaged', 'Category: Damage / breakage')), 'reason / attachments')
  assert(await evaluate(`!!document.querySelector('[data-testid=adj-sod]') && !document.querySelector('[data-testid=adj-approve]')`), 'own request can be approved with segregation of duties on')
  assert(new URLSearchParams(await evaluate('location.search')).get('adj') === 'a1', 'detail not addressable')
  await click('[role=dialog] button', 'Close')
  await waitFor(`!document.querySelector('[data-testid=adj-detail]')`, 'detail closed')
  // New adjustment form: warehouse first, system stock / physical count / adjustment, reasons from ERP Settings.
  await click('button', 'Request adjustment')
  await waitFor(`!!document.querySelector('#ad-wh') && !!document.querySelector('#ad-counted') && !!document.querySelector('#ad-diff')`, 'form')
  await click('[role=dialog] button', 'Review')
  await waitFor(bodyHas('Select the warehouse.'), 'warehouse required first')
  await click('#ad-reason')
  await waitFor(`[...document.querySelectorAll('[role=option]')].map((o) => o.innerText.trim()).join('|') === 'Damaged|Count correction'`, 'configured reasons')
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  assert(!rpcCalls('inventory_create_adjustment_v2').length && !rpcCalls('inventory_review_adjustment').length, 'something was posted')
  } finally {
    SERVE_PREFERENCES = false
  }
})

await step('alerts: evaluated on open and acknowledgeable', async () => {
  await goto('/inventory/alerts')
  await waitFor(bodyHas('Mock Closet 1'), 'alert row')
  assert(rpcCalls('inventory_refresh_alerts').length > 0, 'alerts not refreshed')
  assert(await evaluate(bodyHas('Acknowledge')), 'no acknowledge action')
})

// ===========================================================================
// PHASE 5: PRODUCTION & OUTSOURCING
// ===========================================================================
/** Sets the n-th input matching a selector (React-aware) and optionally presses Enter. */
async function fillNth(selector, index, value, enter = false) {
  await evaluate(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (!el) throw new Error('no element ${selector} #${index}');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
  })()`)
  if (enter) {
    for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await sleep(300)
  }
}
const isDisabled = (selector, text) =>
  evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].filter((b) => b.innerText.trim() === ${JSON.stringify(text)}).every((b) => b.disabled)`)

await step('every production page renders for an authorised user', async () => {
  const pages = [
    ['/production/boms', 'BOM-000001'], ['/production/planning', 'Material requirements'], ['/production/orders', 'PRD-000001'],
    ['/production/consumption', 'TXN-000020'], ['/production/receipts', 'FGR-000001'], ['/production/reports', 'Production Orders Summary'],
    ['/production/orders/po1', 'Material issues'], ['/production/boms/bom1', 'Components'],
  ]
  for (const [p, text] of pages) {
    await goto(p)
    await waitFor(bodyHas(text), `${p} shows "${text}"`)
    assert(!(await evaluate(bodyHas("You don't have permission"))), `${p} denied`)
  }
})

// V2 Stage 4: simple production flow
await step('production dashboard: all KPIs (quantities by unit), shortages with a purchase shortcut and recent activity', async () => {
  await goto('/production')
  await waitFor(bodyHasAll('Production Dashboard', 'Total Production Orders', 'Production Today', 'Monthly Production', 'Finished Goods Produced',
    'Raw Materials Consumed', 'Components Consumed', 'Production Shortages', 'Rejected Quantity', 'Pending Production'), 'dashboard KPIs')
  await waitFor(bodyHasAll('1,500.5 KG', '640 PCS', 'MOCK-CLAY', 'Create purchase order', 'Production recorded', '40 PCS accepted'), 'figures, shortage and activity')
  const call = rpcCalls('production_dashboard').at(-1)
  assert(call && call.body.p_from && call.body.p_to, 'dashboard not filtered by period')
  await screenshot('production-dashboard')
})

await step('new production: active BOM fetched, requirements with available / reserved / shortage / source, saved with a request id', async () => {
  await goto('/production/new')
  await waitFor(`!!document.querySelector('#pe-product')`, 'entry form')
  await click('button[type=submit]', 'Save order')
  await waitFor(bodyHas('Choose the finished product.'), 'validation')
  assert(rpcCalls('production_order_v2_save').length === 0, 'saved without a product')
  await fill('#pe-product', 'MOCK-WC-1')
  await press('#pe-product')
  await waitFor(bodyHas('BOM-000001 v1'), 'active BOM shown')
  await fill('#pe-planned', '10')
  await waitFor(bodyHasAll('MOCK-GLZ', 'Purchased', 'short by 5 KG'), 'requirement table and shortage warning')
  await screenshot('production-entry')
  await click('button[type=submit]', 'Save order')
  await waitFor(`location.pathname === '/production/orders/po1'`, 'order page')
  await waitFor(bodyHasAll('PRD-000010 created', 'Warnings (production is not blocked)'), 'saved notice with warnings')
  const s = rpcCalls('production_order_v2_save').at(-1).body
  assert(s.p_order_id === null && s.p_data.product_id === 'p1' && s.p_data.planned_quantity === '10' && s.p_data.warehouse_id === 'w1' && !s.p_data.complete
    && /^[0-9a-f-]{36}$/.test(s.p_idempotency_key), JSON.stringify(s))
})

await step('new production: a product without a BOM shows a warning and components can be added from the screen', async () => {
  await goto('/production/new')
  await waitFor(`!!document.querySelector('#pe-product')`, 'entry form')
  await fill('#pe-product', 'MOCK-CLAY')
  await press('#pe-product')
  await waitFor(bodyHasAll('No active BOM', 'has no active BOM'), 'no-BOM warning')
  await click('button', 'Add missing components')
  await waitFor(`!!document.querySelector('#ac-prod-0')`, 'add components dialog')
  await fill('#ac-prod-0', 'MOCK-WC-1')
  await press('#ac-prod-0')
  await waitFor(`[...document.querySelectorAll('[role=dialog]')].some((d) => d.innerText.includes('Mock Closet 1'))`, 'component chosen')
  await fill('#ac-qty-0', '2')
  await click('[role=dialog] button', 'Add to BOM')
  await waitFor(bodyHas('BOM-000009 v1 is now active'), 'added notice')
  const a = rpcCalls('production_bom_add_components').at(-1).body
  assert(a.p_product_id === 'p3' && a.p_items[0].component_product_id === 'p1' && a.p_items[0].quantity_per_unit === '2', JSON.stringify(a))
})

await step('complete production: actual output, rejected and actual consumption per material are sent; results and variances shown', async () => {
  await goto('/production/orders/po1')
  await waitFor(bodyHasAll('Material requirement', 'Complete production', 'Correct production', 'Step-by-step tools'), 'order actions')
  await click('button', 'Complete production')
  await waitFor(`!!document.querySelector('#cp-actual')`, 'completion dialog')
  await fill('#cp-actual', '10')
  await fill('#cp-rej', '1')
  await fill('input[aria-label="MOCK-GLZ consumed"]', '2.5')
  await waitFor(bodyHas('over standard'), 'variance shown')
  await screenshot('production-complete')
  await click('[role=dialog] button[type=submit]')
  await waitFor(bodyHasAll('PRD-000001 completed: 9 PCS accepted into stock, 1 rejected (FGR-000010)', 'extra recorded as material wastage'), 'completed notice')
  const c = rpcCalls('production_order_v2_complete').at(-1).body
  assert(c.p_order_id === 'po1' && c.p_data.actual_quantity === '10' && c.p_data.rejected_quantity === '1' && c.p_data.rejected_location_id === null
    && c.p_data.materials.find((m) => m.order_material_id === 'pm2').quantity === '2.5' && /^[0-9a-f-]{36}$/.test(c.p_idempotency_key), JSON.stringify(c))
})

await step('correct production: needs a reason; reverses and re-posts in one call', async () => {
  await goto('/production/orders/po1')
  await waitFor(bodyHas('Correct production'), 'order page')
  await click('button', 'Correct production')
  await waitFor(`!!document.querySelector('#cp-reason')`, 'correction dialog')
  await click('[role=dialog] button[type=submit]')
  await waitFor(bodyHas('Enter the reason for the correction'), 'reason required')
  assert(rpcCalls('production_order_v2_correct').length === 0, 'corrected without a reason')
  await fill('#cp-reason', 'Rejected unit was reworked')
  await fill('#cp-rej', '0')
  await click('[role=dialog] button[type=submit]')
  await waitFor(bodyHas('corrected: earlier postings reversed (TXN-000050)'), 'corrected notice')
  const k = rpcCalls('production_order_v2_correct').at(-1).body
  assert(k.p_reason === 'Rejected unit was reworked' && k.p_data && k.p_data.rejected_quantity === '0', JSON.stringify(k))
})

await step('production import: template, preview with row errors, only valid rows imported after confirming', async () => {
  for (const f of readdirSync(downloadDir)) rmSync(path.join(downloadDir, f), { force: true })
  await goto('/production/orders')
  await waitFor(bodyHasAll('New production', 'Import from Excel'), 'orders page buttons')
  await click('a', 'Import from Excel')
  await waitFor(`location.pathname === '/production/import'`, 'import page')
  await waitFor(bodyHas('Download template'), 'template button')
  await click('button', 'Download template')
  let file
  for (let i = 0; i < 50 && !file; i++) { await sleep(100); file = readdirSync(downloadDir).find((f) => f === 'production-import-template.xlsx') }
  assert(file, 'template not downloaded')
  const header = XLSX.utils.sheet_to_json(XLSX.read(readFileSync(path.join(downloadDir, file))).Sheets.Production, { header: 1 })[0]
  assert(header.join('|') === 'Production Date|Finished Product SKU|Planned Quantity|Actual Quantity|Rejected Quantity|Remarks', 'wrong template ' + JSON.stringify(header))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Production Date', 'Finished Product SKU', 'Planned Quantity', 'Actual Quantity', 'Rejected Quantity', 'Remarks'],
    [TODAY, 'MOCK-WC-1', 10, '', '', 'Open order'],
    [TODAY, 'NOPE', 5, '', '', ''],
    [TODAY, 'MOCK-WC-1', 4, 4, 1, 'Done'],
  ]), 'Production')
  const filePath = path.join(outDir, 'production-import.xlsx')
  writeFileSync(filePath, XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }))
  await setFile(filePath)
  await waitFor(bodyHasAll('Preview', 'SKU "NOPE" was not found', 'Completed production', 'Open order'), 'preview')
  const p = rpcCalls('production_import_preview').at(-1).body
  assert(p.p_rows.length === 3 && p.p_rows[0].row_number === 2 && p.p_rows[2].actual_quantity === '4' && p.p_warehouse_id === 'w1', JSON.stringify(p))
  assert(rpcCalls('production_import').length === 0, 'imported before confirming')
  await screenshot('production-import-preview')
  await click('button', 'Import 2 row(s)')
  await waitFor(bodyHas('Import 2 production row(s)?'), 'confirmation')
  await click('[role=alertdialog] button', 'Import')
  await waitFor(bodyHasAll('2 production order(s) created, 1 row(s) not imported', 'Not imported'), 'summary')
  const im = rpcCalls('production_import').at(-1).body
  assert(im.p_rows.length === 3 && im.p_file.file_name === 'production-import.xlsx' && /^[0-9a-f-]{36}$/.test(im.p_idempotency_key), JSON.stringify(im))
})

// V2 single-operator: the approve button is not blocked in the browser; if a
// company turns segregation of duties on, the database refuses self-approval.
await step('BOM: own pending version can be approved by the single operator', async () => {
  await goto('/production/boms/bom2')
  await waitFor(bodyHas('Workflow'), 'bom detail')
  assert(!(await isDisabled('button', 'Approve')), 'own BOM approve disabled')
  assert(!(await evaluate(bodyHas('another authorised user must approve'))), 'outdated SoD explanation shown')
})

await step('BOM: new BOM validates and saves components through the RPC', async () => {
  await goto('/production/boms/new')
  await waitFor(`document.querySelector('#bom-product')`, 'editor')
  await fill('#bom-product', 'MOCK-WC-1')
  await press('#bom-product')
  await waitFor(bodyHas('Mock Closet 1'), 'output product')
  // V2: each line has a source and a preferred supplier (both default to the product's).
  assert(await evaluate(bodyHasAll('Source', 'Preferred supplier', 'From product')), 'source / supplier columns missing')
  await fill('input[aria-label="Quantity line 1"]', '2.5')
  await click('button', 'Create draft BOM')
  await waitFor(bodyHas('Line 1: select the component.'), 'client validation')
  assert(rpcCalls('production_save_bom').length === 0, 'saved a line without a component')
  // The selector searches name / SKU / barcode / supplier model and shows SKU, unit and stock; the output product cannot be its own component.
  await fillNth('input[placeholder^="Search name, SKU"]', 0, 'MOCK')
  await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('Mock ceramic body'))`, 'component suggestions')
  assert(await evaluate(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('Mock Closet 1') && o.getAttribute('aria-disabled') === 'true' && o.innerText.includes('own component'))`),
    'the output product is offered as its own component')
  assert(await evaluate(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('SKU MOCK-CLAY') && o.innerText.includes('KG') && (o.innerText.includes('Available') || o.innerText.includes('stock not shown')))`),
    'suggestion lacks SKU, unit or stock')
  await click('[role=option]', 'Mock ceramic body')
  await waitFor(bodyHas('Mock ceramic body'), 'component chosen')
  await fill('input[aria-label="Quantity line 1"]', '2.5')
  await fill('input[aria-label="Wastage line 1"]', '5')
  await waitFor(`(document.querySelector('[data-testid="bom-calc-1"]')?.innerText ?? '').includes('wastage =')`, 'quantity + wastage shown')
  // A second component; the first one is shown as already on line 1.
  await click('button', 'Add component')
  await fillNth('input[placeholder^="Search name, SKU"]', 0, 'MOCK')
  await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('Mock ceramic body') && o.innerText.includes('already on line 1'))`, 'duplicate component blocked')
  await click('[role=option]', 'Mock glaze')
  await waitFor(`document.body.innerText.includes('MOCK-GLZ')`, 'second component chosen')
  await fill('input[aria-label="Quantity line 2"]', '1.5')
  await screenshot('bom-component-selector')
  await click('button', 'Create draft BOM')
  await waitFor(`location.pathname === '/production/boms/bom1'`, 'navigated to the saved BOM')
  const b = rpcCalls('production_save_bom').at(-1).body
  assert(b.p_bom_id === null && b.p_finished_product_id === 'p1' && /^[0-9a-f-]{36}$/.test(b.p_idempotency_key), JSON.stringify(b))
  assert(b.p_items.length === 2 && b.p_items[0].component_product_id === 'p3' && b.p_items[0].quantity_required === 2.5 && b.p_items[0].wastage_percentage === 5 && b.p_items[0].unit === 'KG'
    && b.p_items[1].component_product_id === 'p4' && b.p_items[1].quantity_required === 1.5, JSON.stringify(b.p_items))
  assert(b.p_items[0].source_type === null && b.p_items[0].preferred_supplier_id === null, 'blank source / supplier must be sent as null (server applies the product defaults)')
})

// BOM tools: clone, generate multiple, comparison (migration 20261203090000). BOM templates and "Create similar product" were removed.
await step('BOM tools 1: the BOM list offers Create New BOM, Generate multiple and Compare (no templates, no similar product); a BOM offers clone, generate and compare', async () => {
  await goto('/production/boms')
  await waitFor(bodyHasAll('BOM-000001', 'Create New BOM', 'Generate multiple', 'Compare BOMs'), 'list actions')
  assert(!(await evaluate(bodyHas('Create similar product'))) && !(await evaluate(bodyHas('BOM templates'))), 'removed actions still on the BOM list')
  await click('a', 'Generate multiple')
  await waitFor(`location.pathname === '/production/boms/generate' && !!document.querySelector('#gen-base')`, 'Generate multiple opens (base BOM choice)')
  await goto('/production/boms')
  await waitFor(bodyHas('BOM-000001'), 'list again')
  await goto('/production/boms/bom1')
  await waitFor(`!!document.querySelector('[data-testid=bom-reuse]')`, 'reuse card')
  assert(await evaluate(`(() => { const t = document.querySelector('[data-testid=bom-reuse]').innerText; return ['Clone BOM', 'Generate multiple', 'Compare with other BOMs'].every((x) => t.includes(x)) && !t.includes('Create similar product') && !t.includes('template') })()`), 'reuse actions')
  // Clone BOM: the editor opens as a new draft filled from BOM-000001 (the product is chosen by the user).
  await click('[data-testid=bom-reuse] a', 'Clone BOM')
  await waitFor(`location.search === '?clone=bom1' && !!document.querySelector('[data-testid=bom-clone-note]')`, 'clone mode')
  await waitFor(`document.querySelector('#bom-change-reason')?.value === 'Cloned from BOM-000001 v1 (MOCK-WC-1)' && ${bodyHas('Mock ceramic body')}`, 'components copied')
  assert(rpcCalls('production_save_bom').every((c) => c.body.p_bom_id !== 'bom1'), 'the source BOM was saved')
})

await step('ERP search 1: the BOM list searches components on the server (debounced, one request per text), shows related matches, clears with Escape', async () => {
  await goto('/production/boms')
  await waitFor(bodyHas('BOM-000001'), 'BOM list')
  const box = 'input[placeholder^="Search BOM code"]'
  const before = rpcCalls('bom_search').length
  // A component (not a list column): 'glaze' + 'mock' in any order, typed with extra spaces.
  await fillNth(box, 0, '  GLAZE   mock ')
  for (let i = 0; i < 40 && rpcCalls('bom_search').length === before; i++) await sleep(100)
  const calls = rpcCalls('bom_search').slice(before)
  assert(calls.length === 1 && calls[0].body.p_search === 'GLAZE mock', `one debounced, normalised request: ${JSON.stringify(calls.map((c) => c.body))}`)
  await waitFor(bodyHas('BOM-000001'), 'BOM found through its component (not filtered away on the client)')
  // The same text again (only spacing differs): no new request.
  await fillNth(box, 0, 'GLAZE mock')
  await sleep(700)
  assert(rpcCalls('bom_search').length === before + 1, 'identical search repeated')
  await fillNth(box, 0, 'qqqzzz')
  await waitFor(bodyHas('Every word must appear'), 'no-results message explains the rule')
  await press(box, 'Escape')
  await waitFor(`document.querySelector(${JSON.stringify(box)}).value === '' && ${bodyHas('BOM-000001')}`, 'Escape clears the search')
})

await step('ERP search 2: Product Master search sends middle-of-word, multi-word filters (every word, any order, quoted values)', async () => {
  await goto('/products')
  await waitFor(bodyHas('MOCK-WC-1'), 'product list')
  const before = requests.length
  await fill('input[aria-label="Search products"]', 'loset   mock')
  const decoded = () => requests.slice(before).filter((r) => r.path === '/rest/v1/products').map((r) => decodeURIComponent(r.query.split('+').join(' ')))
  for (let i = 0; i < 40 && !decoded().some((x) => x.includes('%loset%')); i++) await sleep(100)
  const q = decoded().find((x) => x.includes('%loset%')) ?? ''
  assert(q.includes('product_name.ilike."%loset%"') && q.includes('and(or(') && q.includes('description.ilike.') && q.includes('product_name.ilike."%loset mock%"'), q)
  await waitFor(bodyHas('MOCK-WC-1'), 'middle-of-word search finds the product')
})

await step('BOM tools 2: BOM Templates and Create Similar Product are gone: no sidebar entry (Product Master & BOM), old addresses redirect, other BOM routes work', async () => {
  await goto('/production/boms')
  await waitFor(bodyHas('BOM-000001'), 'BOM list')
  const navText = `[...document.querySelectorAll('nav a, aside a')].map((a) => a.innerText.trim() + ' ' + a.getAttribute('href'))`
  const nav = await evaluate(navText)
  assert(nav.some((t) => t.includes('/production/boms')) && !nav.some((t) => /template/i.test(t) || t.includes('/production/bom-templates') || t.includes('/production/boms/similar')), JSON.stringify(nav))
  await goto('/production/bom-templates')
  await waitFor(`location.pathname === '/production/boms'`, 'templates address → BOM list')
  await goto('/production/boms/similar?source=bom1')
  await waitFor(`location.pathname === '/production/boms/generate'`, 'similar address → Generate multiple (never a BOM called "similar")')
  await goto('/production/bom-templates/new?bom=bom1')
  await waitFor(bodyHas('Page not found'), 'template editor address: not found')
  await goto('/production/boms/bom1')
  await waitFor(`!!document.querySelector('[data-testid=bom-reuse]')`, 'BOM detail still opens')
  await goto('/production/boms/bom2/versions')
  await waitFor(`!(${bodyHas('could not be displayed')}) && ${bodyHas('BOM versions')}`, 'version history still opens')
})

await step('BOM tools 3: generate multiple with new product names — one base BOM, independent components per product, preview, duplicate SKU refused, all saved as drafts in one call', async () => {
  await goto('/production/boms/generate?source=bom1')
  await waitFor(`!!document.querySelector('#gen-name-1') && !!document.querySelector('#gen-name-2')`, 'two product rows')
  await fill('#gen-name-1', 'Closet A')
  await fill('#gen-sku-1', 'CL-A')
  await fill('#gen-name-2', 'Closet B')
  await fill('#gen-sku-2', 'cl-a')
  await click('[data-testid=gen-save]')
  await waitFor(`document.querySelector('[data-testid=gen-error]')?.innerText.includes('SKU cl-a is used for another row')`, 'duplicate SKU refused')
  await fill('#gen-sku-2', 'CL-B')
  await click('[data-testid=gen-edit-2]')
  await waitFor(`!!document.querySelector('#gen2-qty-1')`, 'components of product 2')
  await fill('#gen2-qty-1', '5')
  await waitFor(`document.querySelector('[data-testid=gen-summary-2]')?.innerText.includes('1 changed') && document.querySelector('[data-testid=gen-summary-1]')?.innerText.includes('same components')`, 'independent changes')
  assert(await evaluate(`document.querySelector('[data-testid=gen-preview]').innerText.includes('MOCK-CLAY × 5 KG') && document.querySelector('[data-testid=gen-preview]').innerText.includes('MOCK-CLAY × 2.5 KG')`), 'preview')
  await screenshot('202-generate-similar')
  await click('[data-testid=gen-save]')
  await waitFor(`!!document.querySelector('[data-testid=gen-confirm]')`, 'confirmation')
  await click('[data-testid=gen-confirm-save]')
  await waitFor(`document.querySelector('[data-testid=gen-result]')?.innerText.includes('2 draft BOMs created')`, 'created')
  const c = rpcCalls('bom_create_similar_products').at(-1).body
  assert(c.p_source.bom_id === 'bom1' && c.p_products.length === 2 && c.p_products[0].product.sku === 'CL-A' && c.p_products[1].product.sku === 'CL-B'
    && c.p_products[0].items[0].quantity_required === 2.5 && c.p_products[1].items[0].quantity_required === 5 && c.p_products[1].items.length === 2, JSON.stringify(c.p_products))
  assert(!rpcCalls('production_bom_activate').some((x) => ['nb1', 'nb2'].includes(x.body.p_bom_id)), 'generated BOMs activated')
})

await step('BOM tools 3b: Generate multiple — Product Name searches the Product Master by name and SKU, SKU filled from it, each product once; component × clears the line without leaving the page, bin removes it, cost recalculates; saved in one call', async () => {
  const [clay, glaze] = [products.find((x) => x.id === 'p3'), products.find((x) => x.id === 'p4')]
  const before = [clay.standard_cost, glaze.standard_cost]
  clay.standard_cost = 40
  glaze.standard_cost = 400
  products.push(product(91, { sku: 'MOCK-BASIN-91', product_name: 'Mock Basin 91' }))
  try {
    await goto('/production/boms/generate?source=bom1')
    await waitFor(`!!document.querySelector('#gen-name-1') && !!document.querySelector('#gen-name-2')`, 'rows')
    // Clicking Product name lists Product Master products (name, SKU, unit, type); the base product and raw materials cannot be chosen.
    await click('#gen-name-1')
    const opts = `[...document.querySelectorAll('[data-testid=gen-name-1-list] [role=option]')]`
    await waitFor(`${opts}.some((o) => o.innerText.includes('Mock Basin 91') && o.innerText.includes('SKU MOCK-BASIN-91') && o.innerText.includes('PCS') && o.innerText.includes('Finished Good'))`, 'Product Master products listed')
    assert(await evaluate(`${opts}.some((o) => o.innerText.includes('Mock Closet 1') && o.getAttribute('aria-disabled') === 'true' && o.innerText.includes("the base BOM's product"))`), 'base product choosable')
    assert(await evaluate(`${opts}.some((o) => o.innerText.includes('Mock ceramic body') && o.getAttribute('aria-disabled') === 'true' && o.innerText.includes('cannot have a BOM'))`), 'raw material choosable')
    // Search by SKU, choose: the SKU comes from the Product Master (read-only).
    await fill('#gen-name-1', 'BASIN-91')
    await waitFor(`${opts}.length === 1 && ${opts}[0].innerText.includes('Mock Basin 91')`, 'SKU search')
    await click('[data-testid=gen-name-1-list] [role=option]', 'Mock Basin 91')
    await waitFor(`!!document.querySelector('[data-testid=gen-name-1-picked]') && document.querySelector('#gen-sku-1')?.value === 'MOCK-BASIN-91' && document.querySelector('#gen-sku-1')?.readOnly`, 'SKU fetched')
    // Search by name on row 2: the product is already chosen for row 1.
    await fill('#gen-name-2', 'Mock Basin')
    const opts2 = `[...document.querySelectorAll('[data-testid=gen-name-2-list] [role=option]')]`
    await waitFor(`${opts2}.some((o) => o.innerText.includes('Mock Basin 91') && o.getAttribute('aria-disabled') === 'true' && o.innerText.includes('already chosen for product 1'))`, 'duplicate prevented')
    await fill('#gen-name-2', 'zzz no such product')
    await waitFor(`document.querySelector('[data-testid=gen-name-2-empty]')?.innerText.includes('No Product Master product matches')`, 'empty state')
    await fill('#gen-name-2', 'Closet New')
    await fill('#gen-sku-2', 'CL-NEW')
    // Components of row 1: 2.5 KG clay × ₹40 = 100 + 0.2 KG glaze × 1.1 × ₹400 = 88 → ₹188.00.
    await click('[data-testid=gen-edit-1]')
    await waitFor(`!!document.querySelector('#gen1-qty-2') && document.querySelector('[data-testid=gen-summary-1]')?.innerText.includes('188.00')`, 'components and cost')
    await fill('input[aria-label="Remarks line 2"]', 'Two coats')
    // × on line 2: clears only that component; no navigation, no error page, other line unchanged, cost recalculated.
    const path0 = await evaluate('location.pathname + location.search')
    await click('button[aria-label="Change Component line 2"]')
    await waitFor(`!!document.querySelector('#gen1-comp-2')`, 'line 2 cleared, search shown')
    await sleep(300)
    assert(await evaluate(`location.pathname + location.search`) === path0 && !(await evaluate(bodyHas('could not be displayed'))), 'navigated or crashed')
    assert(await evaluate(`document.querySelector('#gen1-qty-2').value === '' && document.querySelector('#gen1-waste-2').value === '0' && document.querySelector('input[aria-label="Remarks line 2"]').value === ''
      && document.querySelector('#gen1-qty-1').value === '2.5' && document.querySelector('[data-testid=gen1-line-1]').innerText.includes('MOCK-CLAY')`), 'line reset / other line changed')
    await waitFor(`document.querySelector('[data-testid=gen-summary-1]')?.innerText.includes('100.00')`, 'cost after clearing')
    // Choose another component: SKU, unit and Product Master cost fetched; the cost is shown while searching.
    await fill('#gen1-comp-2', 'MOCK-GLZ')
    await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('Mock glaze') && o.innerText.includes('KG') && o.innerText.includes('Cost ₹400.00'))`, 'component search with cost')
    await click('[role=option]', 'Mock glaze')
    await waitFor(`document.querySelector('[data-testid=gen1-line-2]')?.innerText.includes('MOCK-GLZ') && document.querySelector('[data-testid=gen1-cost-2]')?.innerText.includes('400.00')`, 'component details')
    await fill('#gen1-qty-2', '0.5')
    await waitFor(`document.querySelector('[data-testid=gen-summary-1]')?.innerText.includes('300.00')`, 'cost with the new component (100 + 0.5 × 400)')
    await screenshot('207-generate-multiple-existing')
    // Bin: removes the whole line; line 1 unchanged.
    await click('button[aria-label="Remove line 2"]')
    await waitFor(`!document.querySelector('[data-testid=gen1-line-2]') && document.querySelector('#gen1-qty-1')?.value === '2.5' && document.querySelector('[data-testid=gen-summary-1]')?.innerText.includes('100.00')`, 'line removed')
    await click('[data-testid=gen-save]')
    await waitFor(`!!document.querySelector('[data-testid=gen-confirm]')`, 'confirmation')
    assert(await evaluate(`document.querySelector('[data-testid=gen-confirm]').innerText.includes('MOCK-BASIN-91 (existing)')`), 'confirmation lists the existing product')
    await click('[data-testid=gen-confirm-save]')
    await waitFor(`document.querySelector('[data-testid=gen-result]')?.innerText.includes('2 draft BOMs created') && document.querySelector('[data-testid=gen-result]')?.innerText.includes('(existing product)')`, 'saved')
    const c = rpcCalls('bom_generate_multiple').at(-1).body
    assert(c.p_source.bom_id === 'bom1' && c.p_entries.length === 2 && c.p_entries[0].product_id === 'p91' && !('product' in c.p_entries[0])
      && c.p_entries[0].items.length === 1 && c.p_entries[0].items[0].component_product_id === 'p3' && c.p_entries[0].items[0].quantity_required === 2.5
      && c.p_entries[1].product.sku === 'CL-NEW' && c.p_entries[1].items.length === 2 && /^[0-9a-f-]{36}$/.test(c.p_idempotency_key), JSON.stringify(c))
    assert(!rpcCalls('production_bom_activate').some((x) => ['gb1', 'gb2'].includes(x.body.p_bom_id)), 'generated BOMs activated')
  } finally {
    clay.standard_cost = before[0]
    glaze.standard_cost = before[1]
    products.splice(products.findIndex((x) => x.id === 'p91'), 1)
  }
})

await step('BOM tools 3c: Generate multiple — Add Components from Existing BOM: each product copies a saved BOM (search by number / product), edits stay in the copy, reference clears without removing components, template saved only as provenance', async () => {
  const itemsBefore = JSON.stringify(tables.bom_item_list)
  const bomsBefore = JSON.stringify(tables.bom_list_v2)
  const reqBefore = requests.length
  await goto('/production/boms/generate?source=bom1')
  await waitFor(`!!document.querySelector('#gen-name-1') && !!document.querySelector('#gen-name-2')`, 'rows')
  await fill('#gen-name-1', 'Basin from template')
  await fill('#gen-sku-1', 'BT-1')
  await fill('#gen-name-2', 'Basin two')
  await fill('#gen-sku-2', 'BT-2')
  // Product 1: the section follows the component editor; search by the middle of the BOM number.
  await click('[data-testid=gen-edit-1]')
  await waitFor(`!!document.querySelector('#gen1-tpl-search') && document.querySelector('#gen1-qty-1')?.value === '2.5'`, 'section shown under the components')
  const opts1 = `[...document.querySelectorAll('[data-testid=gen1-tpl-list] [role=option]')]`
  await fill('#gen1-tpl-search', 'zzz-no-bom')
  await waitFor(`!!document.querySelector('[data-testid=gen1-tpl-empty]')`, 'no-results state')
  await fill('#gen1-tpl-search', '00001')
  await waitFor(`${opts1}.length === 2 && ${opts1}.every((o) => o.innerText.includes('BOM-000001') && o.innerText.includes('Mock Closet 1') && o.innerText.includes('2 components'))`, 'saved BOMs listed with product and component count')
  const searched = rpcCalls('bom_search').at(-1).body
  assert(searched.p_search === '00001' && searched.p_status === 'ACTIVE', JSON.stringify(searched))
  await click('[data-testid=gen1-tpl-list] [role=option]', 'v2')
  await waitFor(`!!document.querySelector('[data-testid=gen1-tpl-preview]') && document.querySelector('[data-testid=gen1-tpl-preview]').innerText.includes('BOM-000001 v2')`, 'template preview')
  await click('[data-testid=gen1-tpl-replace]')
  await waitFor(`document.querySelector('#gen1-qty-1')?.value === '2.4' && document.querySelector('[data-testid=gen1-tpl-ref]')?.innerText.includes('BOM-000001 v2')`, 'components copied, reference shown')
  // Edit the copy: quantity and remarks.
  await fill('#gen1-qty-1', '3')
  await fill('input[aria-label="Remarks line 1"]', 'Thicker body')
  // Product 2: a different template (search by product name), copied unchanged.
  await click('[data-testid=gen-edit-2]')
  await waitFor(`!!document.querySelector('#gen2-tpl-search')`, 'section for product 2')
  await fill('#gen2-tpl-search', 'closet mock')
  const opts2 = `[...document.querySelectorAll('[data-testid=gen2-tpl-list] [role=option]')]`
  await waitFor(`${opts2}.some((o) => o.innerText.includes('BOM-000001 v1'))`, 'search by product name, words in any order')
  await click('[data-testid=gen2-tpl-list] [role=option]', 'v1')
  await waitFor(`!!document.querySelector('[data-testid=gen2-tpl-replace]')`, 'preview 2')
  await click('[data-testid=gen2-tpl-replace]')
  await waitFor(`document.querySelector('[data-testid=gen2-tpl-ref]')?.innerText.includes('BOM-000001 v1') && document.querySelector('#gen2-qty-1')?.value === '2.5'`, 'product 2 copied')
  assert(await evaluate(`document.querySelector('#gen1-qty-1').value === '3' && document.querySelector('input[aria-label="Remarks line 1"]').value === 'Thicker body'`), 'product 1 edits changed by product 2')
  // Add to the components: the same BOM again merges by increasing Required Qty (no new rows); a second click adds again (decimals exact).
  await fill('#gen2-tpl-search', 'closet mock')
  await waitFor(`${opts2}.some((o) => o.innerText.includes('BOM-000001 v1'))`, 'search again')
  await click('[data-testid=gen2-tpl-list] [role=option]', 'v1')
  await waitFor(`!!document.querySelector('[data-testid=gen2-tpl-add]')`, 'preview with Add')
  await click('[data-testid=gen2-tpl-add]')
  await waitFor(`document.querySelector('#gen2-qty-1')?.value === '5' && document.querySelector('#gen2-qty-2')?.value === '0.4' && !document.querySelector('#gen2-qty-3')`, 'quantities merged (2.5 + 2.5, 0.2 + 0.2)')
  assert(await evaluate(`document.querySelector('[data-testid=gen2-tpl-notice]').innerText.includes('Required Qty increased for MOCK-CLAY, MOCK-GLZ')`), 'merge notice')
  await click('[data-testid=gen2-tpl-add]')
  await waitFor(`document.querySelector('#gen2-qty-1')?.value === '7.5' && document.querySelector('#gen2-qty-2')?.value === '0.6' && !document.querySelector('#gen2-qty-3')`, 'second click adds again (0.6, not 0.6000000000000001)')
  assert(await evaluate(`document.querySelector('#gen1-qty-1').value === '3' && !document.querySelector('#gen1-qty-3')`), 'product 1 changed by product 2 merge')
  // Remove product 2's template reference: its components stay.
  await click('[data-testid=gen2-tpl-clear]')
  await waitFor(`!document.querySelector('[data-testid=gen2-tpl-ref]') && document.querySelector('#gen2-qty-1')?.value === '7.5'`, 'reference removed, components kept')
  assert(await evaluate(`document.querySelector('[data-testid=gen-summary-1]').innerText.includes('from BOM-000001 v2')`), 'summary shows the template')
  await screenshot('208-generate-multiple-template')
  await click('[data-testid=gen-save]')
  await waitFor(`!!document.querySelector('[data-testid=gen-confirm]')`, 'confirmation')
  assert(await evaluate(`document.querySelector('[data-testid=gen-confirm]').innerText.includes('(from BOM-000001 v2)')`), 'confirmation shows the template')
  await click('[data-testid=gen-confirm-save]')
  await waitFor(`document.querySelector('[data-testid=gen-result]')?.innerText.includes('2 draft BOMs created')`, 'saved')
  const c = rpcCalls('bom_generate_multiple').at(-1).body
  assert(c.p_entries[0].template_bom_id === 'bom2' && c.p_entries[0].items[0].component_product_id === 'p3' && c.p_entries[0].items[0].quantity_required === 3
    && c.p_entries[0].items[0].notes === 'Thicker body' && !('template_bom_id' in c.p_entries[1]) && c.p_entries[1].items.length === 2
    && c.p_entries[1].items[0].quantity_required === 7.5 && c.p_entries[1].items[1].quantity_required === 0.6, JSON.stringify(c))
  // The templates were only read: no BOM write of any kind, mock BOM data unchanged.
  const writes = requests.slice(reqBefore).filter((r) => (r.method !== 'GET' && r.method !== 'HEAD' && !r.path.startsWith('/rest/v1/rpc/'))
    || /rpc\/(production_save_bom|production_bom_|bom_change|bom_version_details_save|inventory_)/.test(r.path))
  assert(writes.length === 0, JSON.stringify(writes.map((w) => w.method + ' ' + w.path)))
  assert(JSON.stringify(tables.bom_item_list) === itemsBefore && JSON.stringify(tables.bom_list_v2) === bomsBefore, 'source BOM data changed')
})

await step('Charts: Inventory by Category with 5, 15, 30, 50 and 100 categories, long names, large and small values, desktop and phone widths; no overlap, Show all, table view, drill-down; GST-exclusive wording', async () => {
  const longName = 'Premium Rimless Wall-Hung Water Closets with Soft-Close Seat Covers'
  const rowsFor = (n) => Array.from({ length: n }, (_, i) => ({ category: i % 7 === 0 ? `${longName} ${i + 1}` : `Category ${String(i + 1).padStart(3, '0')}`, unit: 'PCS',
    on_hand: i === 0 ? 526000 : i % 3 === 0 ? 3 : 1000 + i * 37 }))
  const measure = `(() => {
    const box = document.querySelector('[data-testid=inventory-by-category]')
    const svg = box.querySelector('svg.recharts-surface')
    const rect = (el) => el.getBoundingClientRect()
    const ticks = [...box.querySelectorAll('text[data-full-label]')].map(rect).sort((a, b) => a.top - b.top)
    const labels = [...box.querySelectorAll('.recharts-label-list text')].map(rect).sort((a, b) => a.top - b.top)
    const overlap = (arr) => arr.some((b, i) => i > 0 && b.top < arr[i - 1].bottom - 0.5)
    const s = rect(svg)
    return { ticks: ticks.length, labels: labels.length, tickOverlap: overlap(ticks), labelOverlap: overlap(labels),
      labelClipped: labels.some((l) => l.right > s.right + 1 || l.left < s.left - 1), tickClipped: ticks.some((t) => t.left < s.left - 1),
      shown: Number(box.dataset.shown), titles: [...box.querySelectorAll('text[data-full-label] title')].map((t) => t.textContent),
      texts: [...box.querySelectorAll('text[data-full-label]')].map((t) => t.textContent),
      values: [...box.querySelectorAll('.recharts-label-list text')].map((t) => t.textContent),
      pageScroll: document.documentElement.scrollWidth > window.innerWidth + 1 }
  })()`
  try {
    for (const [width, height, name] of [[1440, 1000, 'desktop'], [1024, 768, 'laptop'], [390, 844, 'phone']]) {
      await setViewport(width, height)
      for (const n of [5, 15, 30, 50, 100]) {
        CATEGORY_ROWS = rowsFor(n)
        await goto('/inventory')
        const shown = n <= 11 ? n : 11
        await waitFor(`document.querySelectorAll('[data-testid=inventory-by-category] .recharts-label-list text').length === ${shown}`, `${name}: ${n} categories drawn`)
        const r = await evaluate(measure)
        const tag = `${name}, ${n} categories`
        assert(r.ticks === shown && r.labels === shown && r.shown === shown, `${tag}: rows ${JSON.stringify([r.ticks, r.labels, r.shown])}`)
        assert(!r.tickOverlap && !r.labelOverlap, `${tag}: labels overlap`)
        assert(!r.labelClipped && !r.tickClipped, `${tag}: label outside the chart`)
        assert(!r.pageScroll, `${tag}: page scrolls horizontally`)
        assert(r.values[0] === '5,26,000', `${tag}: largest first, Indian format (${r.values[0]})`)
        assert(r.titles.some((t) => t.startsWith(longName)) && r.texts.some((t) => t.endsWith('…')), `${tag}: long name truncated with the full name in a tooltip`)
        if (n > 11) assert(r.texts.at(-1).startsWith('Others (') && await evaluate(bodyHas(`Show all (${n})`)), `${tag}: Others row and Show all`)
        if ((name === 'desktop' && n === 15) || (name === 'phone' && n === 30)) { await evaluate(`document.querySelector('[data-testid=inventory-by-category]').scrollIntoView()`); await sleep(200) }
        if (name === 'desktop' && n === 15) await screenshot('210-category-chart-desktop')
        if (name === 'phone' && n === 30) await screenshot('211-category-chart-phone')
      }
    }
    // Show all: 100 categories, every bar drawn with room for its label (the chart scrolls inside the card).
    await setViewport(1440, 1000)
    CATEGORY_ROWS = rowsFor(100)
    await goto('/inventory')
    await waitFor(bodyHas('Show all (100)'), 'show all button')
    await click('[data-testid=inventory-by-category] button', 'Show all (100)')
    await waitFor(`document.querySelectorAll('[data-testid=inventory-by-category] .recharts-label-list text').length === 100`, 'all 100 drawn')
    const all = await evaluate(measure)
    assert(!all.tickOverlap && !all.labelOverlap && !all.labelClipped && all.texts.every((t) => !t.startsWith('Others')), `show all: ${JSON.stringify([all.tickOverlap, all.labelOverlap, all.labelClipped])}`)
    assert(await evaluate(`(() => { const sc = document.querySelector('[data-testid=inventory-by-category] [data-chart=horizontal-bar]'); return sc.scrollHeight > sc.clientHeight })()`), 'long chart scrolls inside its card')
    await evaluate(`document.querySelector('[data-testid=inventory-by-category]').scrollIntoView()`)
    await screenshot('212-category-chart-show-all')
    await click('[data-testid=inventory-by-category] button', 'Top 10')
    await waitFor(`document.querySelectorAll('[data-testid=inventory-by-category] .recharts-label-list text').length === 11`, 'back to top 10 + Others')
    // Table view: every category with its full name and drill-down link.
    await click('[data-testid=inventory-by-category] button[aria-label="Table view"]')
    await waitFor(`document.querySelectorAll('[data-testid=inventory-by-category] tbody tr').length === 100`, 'table lists all 100')
    assert(await evaluate(`[...document.querySelectorAll('[data-testid=inventory-by-category] tbody a')].some((a) => a.innerText === ${JSON.stringify(`${longName} 1`)})`), 'full name in the table')
    await click('[data-testid=inventory-by-category] button[aria-label="Chart view"]')
    // Clicking a bar opens that category's products (drill-down preserved).
    await waitFor(`!!document.querySelector('[data-testid=inventory-by-category] .recharts-bar-rectangle path')`, 'bars')
    await click('[data-testid=inventory-by-category] .recharts-bar-rectangle path')
    await waitFor(`location.pathname === '/drilldown/inventory.category' && new URLSearchParams(location.search).get('seg') === ${JSON.stringify(`${longName} 1`)}`, 'bar opens its category')
    // Empty data: a proper empty state.
    CATEGORY_ROWS = []
    await goto('/inventory')
    await waitFor(`!!document.querySelector('[data-testid=inventory-by-category]') && document.querySelector('[data-testid=inventory-by-category]').innerText.includes('No stock on hand.')`, 'empty state')
  } finally {
    CATEGORY_ROWS = null
    await cdp('Emulation.clearDeviceMetricsOverride')
  }
  // GST-exclusive wording on the dashboards; never "including GST".
  for (const path of ['/', '/purchase-orders/dashboard', '/goods-receipts/dashboard', '/sales/dashboard', '/billing/dashboard', '/ledger/dashboard']) {
    await goto(path)
    await waitFor(`document.querySelector('[data-testid=gst-basis]')?.innerText.includes('All monetary values are in INR, excluding GST. Stock and outstanding balances are as of the current date and time.')`, `${path}: GST basis`)
    assert(!(await evaluate(bodyHas('including GST'))), `${path}: still says including GST`)
  }
  await goto('/')
  await waitFor(bodyHasAll('Taxable Sales', '12,000.00', 'Outstanding Receivables (Excl. GST)', 'Outstanding Payables (Excl. GST) ₹3,780.00', 'Stock Value (Excl. GST)', 'Taxable sales invoiced'), 'management figures excl. GST')
  assert(await evaluate(`document.querySelector('[data-testid=kpi-outstanding-review]')?.innerText.includes('1 part-paid invoice(s) (₹1,121.00 incl. GST) not included')`), 'part-paid invoice flagged for review')
  assert(rpcCalls('gst_exclusive_dashboard').some((c) => c.body.p_scope === 'MANAGEMENT'), 'GST-exclusive figures read from the database')
  await screenshot('213-management-excl-gst')
})

await step('Cost intelligence: BOM list cost columns (INR, dash for non-approved, sortable, tooltips, Recalculate); Product Master Cost Intelligence section, sourcing suggestion and Cost History', async () => {
  await goto('/production/boms?status=ALL&versions=all')
  await waitFor(`!!document.querySelector('[data-testid=bom-cost-bom1]')`, 'BOM cost column')
  const heads = await evaluate(`[...document.querySelectorAll('th')].map((h) => h.innerText.trim().toLowerCase())`)
  for (const h of ['bom cost / unit', 'product master cost', 'cost difference', 'cost updated']) assert(heads.includes(h), `missing column ${h}: ${heads.join(', ')}`)
  assert((await evaluate(`document.querySelector('[data-testid=bom-cost-bom1]').innerText`)) === '₹1,320.69', 'BOM cost / unit of the approved BOM')
  assert((await evaluate(`document.querySelector('[data-testid=bom-cost-bom2]').innerText`)) === '—', 'pending BOM must show a dash')
  assert(await evaluate(`document.querySelector('[data-testid=bom-cost-bom2]').title.includes('never used as the manufacturing cost')`), 'dash tooltip')
  assert(await evaluate(bodyHas('+₹470.69')), 'cost difference')
  assert(await evaluate(bodyHas('₹850.00')), 'product master cost')
  assert(await evaluate(`[...document.querySelectorAll('th')].find((h) => h.innerText.trim().toLowerCase() === 'bom cost / unit').title.includes('wastage')`), 'header tooltip')
  // Sortable: ascending puts the costed BOM first, the dash last.
  await evaluate(`[...document.querySelectorAll('th button')].find((b) => b.innerText.trim().toLowerCase() === 'bom cost / unit').click()`)
  const order = await evaluate(`[...document.querySelectorAll('[data-testid^=bom-cost-]')].map((e) => e.dataset.testid)`)
  assert(order[0] === 'bom-cost-bom1' && order.at(-1) === 'bom-cost-bom2', `sort order ${order}`)
  // Recalculate: confirmation, one call, result shown.
  const n = rpcCalls('product_cost_recalculate').length
  await click('button', 'Recalculate costs')
  await waitFor(bodyHas('Recalculate BOM and Product Master costs?'), 'recalculate confirmation')
  await click('[role=alertdialog] button', 'Recalculate')
  await waitFor(`document.querySelector('[data-testid=bom-cost-notice]')?.innerText.includes('1 Product Master Cost change')`, 'recalculate result')
  assert(rpcCalls('product_cost_recalculate').length === n + 1 && rpcCalls('product_cost_recalculate').at(-1).body.p_product_ids === null, 'one recalculation call for all')
  await screenshot('208-bom-cost-columns')

  // Product Master: Cost Intelligence section.
  await goto('/products/p1')
  await waitFor(`!!document.querySelector('[data-testid=cost-intelligence]')`, 'cost intelligence section')
  const text = (id) => evaluate(`document.querySelector('[data-testid=${id}]')?.innerText ?? ''`)
  assert((await text('ci-bom')).includes('₹1,320.69') && (await text('ci-bom')).includes('BOM-000001 v1'), 'BOM manufacturing cost')
  assert((await text('ci-purchase')).includes('₹920.00'), 'last purchase cost')
  assert((await text('ci-current')).includes('₹850.00'), 'current product master cost')
  assert((await text('ci-source')).includes('GRN (earlier rule'), 'cost source')
  assert((await text('ci-method')).includes('Manufacture'), 'sourcing method')
  assert((await text('ci-status')).includes('No new cost available'), 'cost status')
  // Suggestion from the BOM / GRN history: nothing changes until applied (confirmation).
  await waitFor(`document.querySelector('[data-testid=ci-proposal]')?.innerText.includes('Outsourced-IMP')`, 'sourcing suggestion')
  const applied = rpcCalls('product_sourcing_apply').length
  await click('[data-testid=ci-proposal] button', 'Apply suggestion')
  await waitFor(bodyHas('Change the sourcing method to Outsourced-IMP?'), 'apply confirmation')
  assert(rpcCalls('product_sourcing_apply').length === applied, 'applied before confirmation')
  await click('[role=alertdialog] button', 'Change sourcing method')
  await waitFor(bodyHas('Sourcing method changed to Outsourced-IMP.'), 'applied')
  assert(rpcCalls('product_sourcing_apply').at(-1).body.p_method === 'HYBRID', 'apply payload')
  await screenshot('209-product-cost-intelligence')
  // Cost History tab.
  await click('button', 'Cost History')
  await waitFor(`!!document.querySelector('[data-testid=cost-history] table')`, 'cost history table')
  assert(await evaluate(bodyHas('₹900.00 → ₹850.00')) && await evaluate(bodyHas('GRN reversed')) && await evaluate(bodyHas('GRN-000009')), 'history rows')
})

await step('BOM tools 4: compare BOMs — per finished unit, differences highlighted, totals', async () => {
  await goto('/production/boms/compare?ids=bom1,bom2')
  await waitFor(`!!document.querySelector('[data-testid=compare-result]') && !!document.querySelector('tr[data-component="MOCK-CLAY"]')`, 'comparison')
  assert(await evaluate(`(() => { const cells = [...document.querySelectorAll('tr[data-component="MOCK-CLAY"] td[data-state]')]; return cells.length === 2 && cells[0].dataset.state === 'BASE' && cells[1].dataset.state === 'CHANGED' && cells[1].innerText.includes('2.4') })()`), 'changed quantity highlighted')
  assert(await evaluate(`[...document.querySelectorAll('tr[data-component="MOCK-GLZ"] td[data-state]')].every((c) => ['BASE', 'SAME'].includes(c.dataset.state))`), 'same component not highlighted')
  assert(await evaluate(`!!document.querySelector('[data-testid=compare-totals]')`), 'totals')
  await click('#compare-diff')
  await waitFor(`!document.querySelector('tr[data-component="MOCK-GLZ"]') && !!document.querySelector('tr[data-component="MOCK-CLAY"]')`, 'only differences')
  await screenshot('203-compare-boms')
})

await step('BOM import: reachable from the BOM list; template and upload are offered, nothing is saved before confirming', async () => {
  const savesBefore = rpcCalls('production_save_bom').length
  await goto('/production/boms')
  await waitFor(bodyHas('Import from Excel'), 'import button on the BOM list')
  await click('a', 'Import from Excel')
  await waitFor(`location.pathname === '/production/boms/import'`, 'import page')
  await waitFor(bodyHasAll('Import Bills of Materials', 'Download template', 'Select a spreadsheet'), 'import page content')
  assert(rpcCalls('production_save_bom').length === savesBefore && !(await evaluate(bodyHas('Import finished'))), 'import ran without a file')
})

await step('BOM planning & classification: list columns, filters, sort and Excel export with the six fields', async () => {
  // Both versions of the mock product are exported, so the list shows all versions (default: one row per product).
  await goto('/production/boms?versions=all')
  await waitFor(bodyHasAllCI('Product type', 'Group head', 'Lead time', 'Min. stock days', 'Sanitaryware', '12 d', '15 d'), 'planning columns')
  assert(await evaluate(`Boolean(document.querySelector('[aria-label="Product type filter"]')) && Boolean(document.querySelector('[aria-label="Group head filter"]'))`), 'filters missing')
  for (const f of readdirSync(downloadDir)) rmSync(path.join(downloadDir, f), { force: true })
  await click('button', 'Export to Excel')
  let file
  for (let i = 0; i < 50 && !file; i++) { await sleep(100); file = readdirSync(downloadDir).find((f) => f.startsWith('boms-') && f.endsWith('.xlsx')) }
  assert(file, 'BOM export not downloaded')
  const sheet = XLSX.utils.sheet_to_json(XLSX.read(readFileSync(path.join(downloadDir, file))).Sheets.BOM, { header: 1 })
  for (const h of ['Finished Product SKU', 'Product Name', 'Product Type', 'Tax Rate (%)', 'Lead Time (Days)', 'Group Head', 'Minimum Stock Days', 'Component SKU', 'Quantity per Output', 'Wastage %']) {
    assert(sheet[0].includes(h), `export lacks ${h}: ${JSON.stringify(sheet[0])}`)
  }
  const col = (h) => sheet[1][sheet[0].indexOf(h)]
  assert(col('Tax Rate (%)') === 18 && col('Lead Time (Days)') === 12 && col('Group Head') === 'Sanitaryware' && col('Minimum Stock Days') === 15 && col('Product Type') === 'Finished Good',
    JSON.stringify(sheet[1]))
  assert(sheet.length === 5 && sheet.slice(1).some((r) => r.includes('MOCK-GLZ')), 'one row per component of both BOMs')
})

await step('BOM planning & classification: the BOM shows the product\'s values and saves changes to the Product Master', async () => {
  await goto('/production/boms/bom1')
  await waitFor(bodyHasAll('Product Planning & Classification', 'Tax Rate (%)', 'Lead Time (Days)', 'Group Head', 'Minimum Stock Days'), 'planning card')
  await waitFor(`document.querySelector('[data-testid=bom-product-type]')?.innerText === 'Finished Good'`, 'product type from the Product Master')
  assert(await evaluate(`Boolean(document.querySelector('[data-testid=bom-planning] a[href="/products/p1"]'))`), 'product name not linked to the Product Master')
  await fill('#bom-tax', '150')
  await fill('#bom-lead', '21')
  await fill('#bom-group', 'Faucets')
  await fill('#bom-minstock', '30')
  await click('button', 'Save planning details')
  await waitFor(bodyHas('must be a percentage from 0 to 100'), 'invalid tax rate refused')
  const patches = () => requests.filter((r) => r.method === 'PATCH' && r.path === '/rest/v1/products')
  const before = patches().length
  const bomSaves = rpcCalls('production_save_bom').length
  await fill('#bom-tax', '12')
  await click('button', 'Save planning details')
  await waitFor(`${bodyHas('Saved on')}`, 'planning saved')
  assert(patches().length === before + 1, 'planning not saved once')
  const body = patches().at(-1).body
  assert(body.gst_rate === 12 && body.lead_time_days === 21 && body.group_head === 'Faucets' && body.minimum_cover_days === 30 && !('product_type' in body), JSON.stringify(body))
  assert(rpcCalls('production_save_bom').length === bomSaves, 'saving planning details must not save (or version) the BOM components')
  await screenshot('bom-planning-classification')
})

await step('Product Master: EAN under Product Identification, validated (check digit) before saving', async () => {
  await goto('/products/new')
  await waitFor(`document.querySelector('[data-testid=product-identification]') && document.querySelector('#p-ean')`, 'EAN field')
  assert(await evaluate(`document.querySelector('[data-testid=product-identification] legend').innerText === 'Product Identification' && Boolean(document.querySelector('[data-testid=product-identification] #p-barcode'))`), 'EAN not under Product Identification')
  assert(await evaluate(`Boolean(document.querySelector('#p-group_head')) && Boolean(document.querySelector('#p-minimum_cover_days'))`), 'group head / minimum stock days missing on the product form')
  const posts = () => requests.filter((r) => r.method === 'POST' && r.path === '/rest/v1/products').length
  const before = posts()
  await fill('#p-product_name', 'EAN test basin')
  await fill('#p-ean', '4006381333932')
  await click('button[type=submit]')
  await waitFor(bodyHas('check digit is wrong'), 'EAN check digit error')
  assert(posts() === before, 'saved an invalid EAN')
})

await step('planning: requirements and shortages come from the database; draft order created via RPC', async () => {
  await goto('/production/planning?bom=bom1')
  await waitFor(`document.querySelector('#pl-qty')`, 'planning form')
  await fill('#pl-qty', '60')
  await waitFor(bodyHasAll('MOCK-CLAY', 'Partially available'), 'requirement lines')
  const r = rpcCalls('production_bom_requirements').at(-1).body
  assert(r.p_bom_id === 'bom1' && r.p_quantity === 60 && r.p_warehouse_id === 'w1', JSON.stringify(r))
  assert(await evaluate(bodyHas('material(s) are short')), 'shortage summary not shown')
  assert(!rpcCalls('production_reserve_materials').length && !rpcCalls('production_issue_materials').length, 'planning reserved or issued stock')
  await screenshot('21-production-planning')
  // Target = the planned start the page defaulted to (company time zone), so the step does not depend on the UTC date.
  await fill('#pl-target', await evaluate(`document.querySelector('#pl-start').value`))
  await click('button', 'Create draft production order')
  await waitFor(`location.pathname === '/production/orders/po1'`, 'order page')
  const o = rpcCalls('production_save_order').at(-1).body
  assert(o.p_order_id === null && o.p_bom_id === 'bom1' && o.p_planned_quantity === 60 && o.p_source_warehouse_id === 'w1' && /^[0-9a-f-]{36}$/.test(o.p_idempotency_key), JSON.stringify(o))
})

await step('whole pieces: a fractional PCS planning quantity is refused in the browser (no request sent)', async () => {
  await goto('/production/planning?bom=bom1')
  await waitFor(`document.querySelector('#pl-qty')`, 'planning form')
  const before = rpcCalls('production_bom_requirements').length
  await fill('#pl-qty', '10.5')
  await waitFor(bodyHas('Enter a quantity greater than zero (whole PCS)'), 'whole-piece message')
  await sleep(500)
  assert(rpcCalls('production_bom_requirements').length === before, 'requirements were requested for 10.5 PCS')
  assert(await evaluate(`document.querySelector('#pl-qty').inputMode === 'numeric'`), 'PCS quantity input should use the numeric keyboard')
  await fill('#pl-qty', '10')
  // Table headers are styled uppercase, so check the text content rather than the rendered text.
  await waitFor(`document.body.textContent.includes('Theoretical (BOM ratio)') && document.body.textContent.includes('Planned requirement')`, 'labelled theoretical and planned columns')
})

await step('whole pieces: audit page lists fractional records read-only, with reconciliation guidance', async () => {
  const mutating = () => rpcCalls('inventory_create_adjustment').length + rpcCalls('inventory_review_adjustment').length
  const before = mutating()
  await goto('/inventory/whole-piece-audit')
  await waitFor(bodyHasAll('Whole-piece quantity audit', 'MOCK-A1 @ MAIN/GENERAL', '312.141'), 'audit findings')
  assert(await evaluate(bodyHas('stock adjustment')), 'reconciliation guidance missing')
  await click('button', 'History')
  await waitFor(bodyHas('TXN-000042'), 'ledger history row')
  await click('button', 'BOMs')
  await waitFor(bodyHas('Valid BOM ratio'), 'BOM ratio row')
  assert(mutating() === before, 'the audit page changed data')
  await screenshot('48-whole-piece-audit')
})

await step('production order: issue materials (review, then one posting with the chosen lot)', async () => {
  await goto('/production/orders/po1')
  await waitFor(bodyHasAll('PRD-000001', 'Issue materials'), 'order page')
  await click('button', 'Issue materials')
  await waitFor(`document.querySelector('[aria-label="Lot for MOCK-GLZ"]')`, 'issue dialog')
  await choose('[aria-label="Lot for MOCK-GLZ"]', 'G-1')
  await click('[role=dialog] button', 'Review')
  await waitFor(bodyHas('Review: Issue materials'), 'review step')
  assert(rpcCalls('production_issue_materials').length === 0, 'posted before confirmation')
  await click('[role=dialog] button', 'Post issue')
  await waitFor(bodyHas('Issued: TXN-000031'), 'success only after RPC')
  const calls = rpcCalls('production_issue_materials')
  assert(calls.length === 1, `expected 1 posting, got ${calls.length}`)
  const b = calls[0].body
  assert(b.p_order_id === 'po1' && b.p_lines.length === 1 && /^[0-9a-f-]{36}$/.test(b.p_idempotency_key), JSON.stringify(b))
  assert(b.p_lines[0].order_material_id === 'pm2' && b.p_lines[0].batch_id === 'lot-g1' && b.p_lines[0].location_id === 'l1' && b.p_lines[0].quantity === 2.2, JSON.stringify(b.p_lines))
})

await step('production order: record output into a storage location of the destination warehouse', async () => {
  await click('button', 'Record output')
  await waitFor(`document.querySelector('#out-good')`, 'output dialog')
  await fill('#out-good', '4')
  await click('[role=dialog] button', 'Review')
  await waitFor(bodyHas('Review: Record output'), 'review')
  await screenshot('22-output-review')
  await click('[role=dialog] button', 'Post output')
  await waitFor(bodyHas('Posted FGR-000009'), 'output posted')
  const b = rpcCalls('production_receive_output').at(-1).body
  assert(b.p_order_id === 'po1' && b.p_good_quantity === 4 && b.p_rejected_quantity === 0 && b.p_good_location_id === 'l1' && b.p_rejected_location_id === null, JSON.stringify(b))
  assert(b.p_unit_cost === null, 'unit cost invented')
})

await step('production order: own pending order can be approved by the single operator', async () => {
  await goto('/production/orders/po2')
  await waitFor(bodyHas('PRD-000002'), 'order')
  assert(!(await isDisabled('button', 'Approve')), 'own order approve disabled')
  assert(!(await evaluate(bodyHas('Issue materials'))), 'issue offered on a pending order')
})

await step('production reports: 14 reports run on the server; costs flagged incomplete; batch trace', async () => {
  await goto('/production/reports')
  await waitFor(bodyHas('Production Orders Summary'), 'reports')
  const titles = await evaluate(`[...document.querySelectorAll('nav[aria-label=Reports] button')].map((b) => b.innerText.replace(/^\\d+\\.\\s*/, '').trim()).filter((t) => t !== 'Trace a batch')`)
  assert(titles.length === 14, `expected 14 reports, found ${titles.length}`)
  for (const title of titles) {
    await click('nav[aria-label=Reports] button', title)
    await waitFor(`document.querySelector('h2') && document.querySelector('h2').innerText.includes(${JSON.stringify(title)})`, `report ${title}`)
    await sleep(200)
  }
  const keys = new Set(rpcCalls('production_report').map((c) => c.body.p_report))
  assert(keys.size === 14, `server reports called: ${[...keys].join(',')}`)
  await click('nav[aria-label=Reports] button', 'Production Cost Summary')
  await waitFor(bodyHas('Cost data incomplete'), 'cost status')
  assert(await evaluate(bodyHas('missing costs are never treated as zero')), 'costing method not explained')
  await click('nav[aria-label=Reports] button', 'Trace a batch')
  await fill('input[aria-label="Search batch, SKU or product"]', 'G-1')
  await waitFor(bodyHas('Mock glaze'), 'lot search results')
  await click('ul button', 'G-1')
  await waitFor(bodyHasAll('Used in (forward)', 'PRD-000001'), 'trace result')
  assert(await evaluate(bodyHas('have no production or outsourcing link')), 'missing-link warning not shown')
  assert(rpcCalls('production_trace_batch').at(-1).body.p_batch_id === 'lot-g1', 'wrong lot traced')
  await screenshot('23-batch-trace')
})

// ===========================================================================
// PHASE 6: CUSTOMER PURCHASE ORDERS
// ===========================================================================
async function setFile(filePath) {
  const { root: doc } = await cdp('DOM.getDocument')
  const { nodeId } = await cdp('DOM.querySelector', { nodeId: doc.nodeId, selector: 'input[type=file]' })
  await cdp('DOM.setFileInputFiles', { nodeId, files: [filePath] })
}

// ===========================================================================
await step('sales orders: server-paged list; only the V2 ways to create an order (new order, Excel import)', async () => {
  await goto('/sales/orders')
  await waitFor(bodyHasAll('SO-000001', 'Showing'), 'order list')
  const listQuery = requests.filter((r) => r.path === '/rest/v1/sales_order_list').at(-1)?.query ?? ''
  assert(/offset=0|limit=25/.test(listQuery), `list not paged on the server: ${listQuery}`)
  assert(await evaluate(`!!document.querySelector('main a[href="/sales/orders/new"]') && !!document.querySelector('main a[href="/sales/orders/import"]')`), 'new order / import missing')
  for (const legacy of ['Create from customer PO', 'Manual order']) {
    assert(!(await evaluate(`[...document.querySelectorAll('main button')].some((b) => b.innerText.includes(${JSON.stringify(legacy)}))`)), `legacy action "${legacy}" still shown`)
  }
})

// V2 Stage 5: sales orders with automatic reservations
await step('sales dashboard: all 12 KPIs (quantities per unit), filters, recent orders, shortages and fulfilment summary', async () => {
  await goto('/sales/dashboard')
  await waitFor(bodyHasAll('Sales Dashboard', 'Total Sales Orders', 'Orders Created Today', 'Orders This Month', 'Sales Order Value (Excl. GST)', 'Pending Orders',
    'Partially Fulfilled Orders', 'Fully Fulfilled Orders', 'Cancelled Orders', 'Finished Goods Reserved', 'Production Required', 'Raw Material Shortages', 'Orders Awaiting Dispatch'), 'dashboard KPIs')
  await waitFor(bodyHasAll('340 PCS', '70 PCS', 'SO-000001', 'MOCK-CLAY', 'Shree Clay Works Pvt Ltd', 'Stock Shortage'), 'figures, recent order and shortage')
  await choose('#sd-status', 'Ready for Dispatch')
  for (let i = 0; i < 50 && rpcCalls('sales_dashboard').at(-1).body.p_status !== 'READY_FOR_DISPATCH'; i++) await sleep(100)
  assert(rpcCalls('sales_dashboard').at(-1).body.p_status === 'READY_FOR_DISPATCH', 'status filter not sent')
  await screenshot('sales-dashboard')
})

await step('new sales order: several products with discount and GST, live totals, saved once with a request id; warnings shown', async () => {
  await goto('/sales/orders')
  await waitFor(bodyHasAll('New sales order', 'Import from Excel'), 'list buttons')
  await click('a', 'New sales order')
  await waitFor(`location.pathname === '/sales/orders/new' && !!document.querySelector('#so-customer')`, 'entry form')
  await click('button[type=submit]', 'Save and reserve stock')
  await waitFor(bodyHasAll('Choose the customer.', 'Add at least one product.'), 'validation')
  assert(rpcCalls('sales_order_v2_save').length === 0, 'saved an empty order')
  await choose('#so-customer', 'ACME')
  await fill('#so-p-0', 'MOCK-WC-1')
  await press('#so-p-0')
  await waitFor(bodyHas('MOCK-WC-1 · PCS'), 'product chosen')
  await fill('input[aria-label="Quantity line 1"]', '10')
  await fill('input[aria-label="Price line 1"]', '1000')
  await fill('input[aria-label="Discount line 1"]', '10')
  await fill('input[aria-label="GST line 1"]', '18')
  await fill('#so-freight', '500')
  // 10 x 1000 - 10% = 9000 + 18% = 10620; freight 500 + 18% = 590 -> 11210
  await waitFor(`document.querySelector('[data-testid=so-grand-total]').textContent.includes('11,210')`, 'live grand total')
  await screenshot('sales-order-entry')
  await click('button[type=submit]', 'Save and reserve stock')
  await waitFor(`location.pathname === '/sales/orders/so1'`, 'order page')
  await waitFor(bodyHasAll('SO-000010 created', 'Warnings (production is not blocked)'), 'created notice with warnings')
  const s = rpcCalls('sales_order_v2_save').at(-1).body
  assert(s.p_so_id === null && s.p_header.customer_id === 'cu1' && s.p_header.freight_amount === '500' && s.p_lines.length === 1 && s.p_lines[0].product_id === 'p1'
    && s.p_lines[0].quantity === '10' && s.p_lines[0].discount_percent === '10' && s.p_lines[0].gst_rate === '18' && !s.p_header.draft && /^[0-9a-f-]{36}$/.test(s.p_idempotency_key), JSON.stringify(s))
})

await step('sales order page: fulfilment quantities, shortages with preferred supplier, one-click production order', async () => {
  await goto('/sales/orders/so1')
  await waitFor(bodyHasAll('Order fulfilment', 'Stock Shortage', 'PRD-000001', 'MOCK-CLAY', 'Shree Clay Works Pvt Ltd', 'FUL-000009', 'Customer revised the PO'), 'order page')
  for (const t of ['FG reserved', 'Production qty', 'Produced', 'Available for dispatch', 'Dispatched', 'Pending', 'Recommended purchase', 'quantity: 80 → 100']) {
    assert(await evaluate(`document.body.textContent.includes(${JSON.stringify(t)})`), `missing "${t}"`)
  }
  await screenshot('sales-order-fulfilment')
  await click('button', 'Create Production Order')
  await waitFor(bodyHas('Production order(s) created: PRD-000011 (MOCK-WC-1 10 PCS)'), 'production created')
  const p = rpcCalls('sales_order_v2_create_production').at(-1).body
  assert(p.p_so_id === 'so1' && p.p_line_id === null && /^[0-9a-f-]{36}$/.test(p.p_idempotency_key), JSON.stringify(p))
})

await step('sales order page: no Create Invoice or Dispatch actions; invoicing status shown; a dispatch can still be reversed with a reason', async () => {
  await goto('/sales/orders/so1')
  await waitFor(bodyHasAll('Dispatch history', 'Invoicing', 'Partially Invoiced – 2 PCS Pending', 'INV/26-27/0001'), 'order page with invoicing status')
  assert(!(await evaluate(`[...document.querySelectorAll('main button, main a')].some((b) => ['Dispatch', 'Create invoice'].includes(b.innerText.trim()))`)),
    'Dispatch / Create invoice still offered on the sales order')
  assert(rpcCalls('sales_invoice_tracking').at(-1).body.p_filters.sales_order_id === 'so1', 'invoicing status not loaded for this order')
  assert(rpcCalls('sales_order_v2_dispatch').length === 0, 'a dispatch was started from the sales order page')
  await screenshot('sales-order-invoicing-status')
  await click('button', 'Reverse')
  await waitFor(`!!document.querySelector('#rs-reason')`, 'reverse dialog')
  assert(await isDisabled('[role=dialog] button', 'Reverse dispatch'), 'reversal allowed without a reason')
  await fill('#rs-reason', 'Truck returned to the factory')
  await click('[role=dialog] button', 'Reverse dispatch')
  await waitFor(bodyHas('Dispatch reversed (TXN-000072)'), 'reversed notice')
  assert(rpcCalls('sales_order_v2_reverse_dispatch').at(-1).body.p_fulfilment_id === 'f9', 'wrong consignment reversed')
})

await step('purchase shortage: Create Purchase Order opens the PO form prefilled with shortage items, quantities and the preferred supplier', async () => {
  await goto('/sales/orders/so1')
  await waitFor(bodyHas('Create Purchase Order'), 'order page')
  const posBefore = rpcCalls('purchase_order_save_refs').length
  await click('a', 'Create Purchase Order')
  await waitFor(`location.pathname === '/purchase-orders/new' && location.search === '?from_so=so1'`, 'po form')
  await waitFor(bodyHas('Prefilled with the material shortages of SO-000001'), 'prefill notice')
  assert(await evaluate(`document.querySelector('input[id$="-qty"]').value === '15'`), 'recommended quantity not prefilled')
  assert(await evaluate(`document.querySelector('#po-supplier').innerText.includes('SUP-000001')`), 'preferred supplier not selected')
  assert(rpcCalls('purchase_order_save_refs').length === posBefore, 'a purchase order was saved without the user saving it')
  await screenshot('po-prefill-from-sales-order')
})

await step('sales import: template, grouped preview with a missing customer offered for quick add, valid orders imported after confirming', async () => {
  for (const f of readdirSync(downloadDir)) rmSync(path.join(downloadDir, f), { force: true })
  await goto('/sales/orders/import')
  await waitFor(bodyHas('Download template'), 'import page')
  await click('button', 'Download template')
  let file
  for (let i = 0; i < 50 && !file; i++) { await sleep(100); file = readdirSync(downloadDir).find((f) => f === 'sales-order-import-template.xlsx') }
  assert(file, 'template not downloaded')
  const header = XLSX.utils.sheet_to_json(XLSX.read(readFileSync(path.join(downloadDir, file))).Sheets['Sales Orders'], { header: 1 })[0]
  assert(header.join('|') === 'Order Date|Customer Name|Customer GSTIN|Customer Reference|Product SKU|Product Name|Quantity|Unit|Selling Price|Discount|GST Rate|Expected Delivery Date|Remarks',
    'wrong template ' + JSON.stringify(header))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header,
    [TODAY, 'Acme Ltd', '', 'PO-1', 'MOCK-WC-1', '', 1, 'PCS', 1000, '', 18, '', ''],
    [TODAY, 'Acme Ltd', '', 'PO-1', 'MOCK-WC-1', '', 1, 'PCS', 1000, '', 18, '', ''],
    [TODAY, 'Nobody Ltd', '', 'N-1', 'MOCK-WC-1', '', 1, '', '', '', '', '', ''],
  ]), 'Sales Orders')
  const filePath = path.join(outDir, 'sales-import.xlsx')
  writeFileSync(filePath, XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }))
  await setFile(filePath)
  await waitFor(bodyHasAll('Missing customers and products', 'Add customer Nobody Ltd', 'was not found', 'rows 2, 3'), 'preview')
  const pv = rpcCalls('sales_order_import_preview').at(-1).body
  assert(pv.p_rows.length === 3 && pv.p_rows[0].row_number === 2 && pv.p_rows[0].customer_reference === 'PO-1', JSON.stringify(pv.p_rows[0]))
  assert(rpcCalls('sales_order_import').length === 0, 'imported before confirming')
  await screenshot('sales-import-preview')
  await click('button', 'Import 1 order(s)')
  await waitFor(bodyHas('Import 1 sales order(s)?'), 'confirmation')
  await click('[role=alertdialog] button', 'Import')
  await waitFor(bodyHasAll('1 sales order(s) created, 1 order(s) not imported', 'Imported SO-000011'), 'summary')
  const im = rpcCalls('sales_order_import').at(-1).body
  assert(im.p_rows.length === 3 && im.p_file.file_name === 'sales-import.xlsx' && /^[0-9a-f-]{36}$/.test(im.p_idempotency_key), JSON.stringify(im))
})

await step('partial fulfilment renders outstanding order lines linking to the sales order page', async () => {
  await goto('/sales/backorders')
  await waitFor(bodyHas('Outstanding order lines'), 'partial fulfilment')
  assert(!(await evaluate(bodyHas("You don't have permission"))), 'partial fulfilment denied')
  assert(!(await evaluate(`!!document.querySelector('main a[href^="/sales/order-details"]')`)), 'link to the removed warehouse view')
})

await step('cancellation: preview first, reason required, confirmed cancel calls the server', async () => {
  await goto('/sales/cancellation?so=so2')
  await waitFor(bodyHas('What cancelling SO-000002 does'), 'preview')
  for (const text of ['Will be cancelled', 'Reservations to release', 'Completed stock movements (kept)']) assert(await evaluate(bodyHas(text)), `missing "${text}"`)
  await click('button', 'Cancel order')
  await waitFor(bodyHas('Enter the reason for the cancellation'), 'reason required')
  assert(rpcCalls('sales_order_cancel').length === 0, 'cancel sent without reason')
  await fill('#cx-reason', 'customer withdrew the order')
  await click('button', 'Cancel order')
  await waitFor(`document.querySelector('[role=alertdialog]')`, 'confirm')
  await click('[role=alertdialog] button', 'Cancel order')
  await waitFor(bodyHas('SO-000002 cancelled'), 'cancel result')
  const b = rpcCalls('sales_order_cancel')[0].body
  assert(b.p_so_id === 'so2' && b.p_reason === 'customer withdrew the order' && /^[0-9a-f-]{36}$/.test(b.p_idempotency_key), JSON.stringify(b))
})

await step('create invoice: one creation point; "From dispatches" removed; sales order is the default mode', async () => {
  await goto('/billing/invoices/new?mode=dispatch')
  await waitFor(bodyHasAll('From sales order', 'Manual invoice'), 'creation modes')
  assert(!(await evaluate(bodyHas('From dispatches'))), '"From dispatches" is still offered')
  assert(await evaluate(`document.querySelector('[role=tab][aria-selected=true]')?.innerText === 'From sales order'`), 'an old dispatch link did not open sales-order mode')
  await goto('/billing/invoices/new')
  await waitFor(`document.querySelector('[role=tab][aria-selected=true]')?.innerText === 'From sales order'`, 'sales order is the default mode')
  assert(rpcCalls('sales_invoice_create_draft').length === 0, 'a dispatch invoice was created')
})

await step('issue invoice: confirmation first; success shown only with the server-assigned number', async () => {
  await goto('/billing/invoices/inv1')
  await waitFor(bodyHasAll('Issue invoice', 'The official number is assigned when the invoice is issued'), 'draft actions')
  assert(rpcCalls('sales_invoice_v2_issue').length === 0, 'issued without confirmation')
  // The button is enabled once the dispatch status has loaded.
  await waitFor(`![...document.querySelectorAll('main button')].find((b) => b.innerText.trim() === 'Issue invoice').disabled`, 'issue enabled')
  await click('button', 'Issue invoice')
  await waitFor(`document.querySelector('[role=alertdialog]')`, 'confirm')
  assert(rpcCalls('sales_invoice_v2_issue').length === 0, 'issued before confirming')
  await click('[role=alertdialog] button', 'Issue invoice')
  await waitFor(bodyHas('Invoice INV/26-27/0003 issued'), 'issued message after the RPC')
  // Single-operator mode: one-step issue (no approval); review points come back as warnings.
  assert(await evaluate(bodyHas('Confirmed when issuing')), 'review warning not shown')
  assert(rpcCalls('sales_invoice_issue').length === 0, 'the approval-flow issue was used')
  const b = rpcCalls('sales_invoice_v2_issue').at(-1).body
  assert(b.p_invoice_id === 'inv1' && b.p_convert_proforma === false && /^[0-9a-f-]{36}$/.test(b.p_idempotency_key), JSON.stringify(b))
  await screenshot('51-invoice-detail')
})

await step('invoice posting: disabled until the goods are dispatched; dispatch link; re-checked before posting', async () => {
  dispatchBlocked = true
  try {
    const issuesBefore = rpcCalls('sales_invoice_v2_issue').length
    await goto('/billing/invoices/inv1')
    await waitFor(bodyHasAll('Dispatch status', 'Partially Dispatched', 'Posting is disabled until the remaining quantities are dispatched'), 'dispatch panel')
    for (const text of ['MOCK-WC-1', 'Order SO-000001', 'Charge / service line']) assert(await evaluate(bodyHas(text)), `missing "${text}"`)
    assert(await evaluate(`[...document.querySelectorAll('main button')].find((b) => b.innerText.trim() === 'Issue invoice').disabled`), 'post enabled with goods outstanding')
    assert(await evaluate(`Boolean(document.querySelector('main a[href="/sales/orders/so1"]'))`), 'no link to the dispatch workflow')
    dispatchBlocked = false
    const checks = rpcCalls('invoice_dispatch_status').length
    await click('button', 'Check again')
    await waitFor(bodyHas('Ready to Post'), 'ready after dispatch')
    assert(rpcCalls('invoice_dispatch_status').length > checks, 'status not fetched again')
    await waitFor(`![...document.querySelectorAll('main button')].find((b) => b.innerText.trim() === 'Issue invoice').disabled`, 'post enabled')
    // Dispatch reversed meanwhile: the pre-post re-check refuses without calling the issue RPC.
    dispatchBlocked = true
    await click('button', 'Issue invoice')
    await waitFor(`document.querySelector('[role=alertdialog]')`, 'confirm')
    await click('[role=alertdialog] button', 'Issue invoice')
    await waitFor(bodyHas('Dispatch the goods before posting. MOCK-WC-1 Mock Closet 1: 6 PCS of 10 still to dispatch'), 'blocked message')
    assert(rpcCalls('sales_invoice_v2_issue').length === issuesBefore, 'issue RPC called although goods are not dispatched')
    await screenshot('51b-invoice-dispatch-blocked')
  } finally { dispatchBlocked = false }
})

await step('partial invoice: warning before posting (Go Back posts nothing, Continue posts); dispatched on posting; Super Admins notified', async () => {
  partialPreview = true
  try {
    await goto('/billing/invoices/inv1')
    await waitFor(bodyHas('Dispatch status'), 'invoice page')
    await waitFor(`(() => { const b = [...document.querySelectorAll('main button')].find((x) => x.innerText.trim() === 'Issue invoice'); return b && !b.disabled })()`, 'issue enabled')
    const before = rpcCalls('sales_invoice_v2_issue').length
    await click('button', 'Issue invoice')
    await waitFor(`document.querySelector('[data-testid=partial-invoice-warning]')`, 'partial warning')
    assert(await evaluate(bodyHasAll('Partial Invoice Warning',
      'You are creating an invoice for 8 PCS of MOCK-WC-1 against Sales Order SO-000001 of 10 PCS. The remaining 2 PCS will stay pending for future invoicing. They will not be added to actual inventory.',
      'Continue with Partial Invoice', 'Go Back')), 'warning text')
    await screenshot('partial-invoice-warning')
    await click('[role=dialog] button', 'Go Back')
    await waitFor(`!document.querySelector('[data-testid=partial-invoice-warning]')`, 'warning closed')
    assert(rpcCalls('sales_invoice_v2_issue').length === before, 'posted after Go Back')
    await click('button', 'Issue invoice')
    await waitFor(`document.querySelector('[data-testid=partial-invoice-warning]')`, 'partial warning again')
    await click('[role=dialog] button', 'Continue with Partial Invoice')
    await waitFor(`document.querySelector('[role=alertdialog]')`, 'final confirm')
    await click('[role=alertdialog] button', 'Issue invoice')
    await waitFor(bodyHasAll('Invoice INV/26-27/0003 issued', '8 dispatched from reserved stock', 'Partial invoice: the remaining order quantity stays pending; Super Admins were notified.'), 'partial posted')
    assert(rpcCalls('sales_invoice_v2_issue').length === before + 1, 'not posted exactly once')
  } finally { partialPreview = false }
})

await step('stock register: Pending / Incomplete Invoice Orders (non-stock label, totals, links, reports, Excel) and Release Pending Quantity', async () => {
  pendingReleased = false
  try {
    await goto('/inventory/stock')
    await waitFor(bodyHas('Pending / Incomplete Invoice Orders'), 'section tabs')
    await click('[role=group] button', 'Pending / Incomplete Invoice Orders')
    await waitFor(`location.search === '?view=pending-invoice'`, 'pending section')
    await waitFor(bodyHasAllCI('Non-stock tracking quantity – excluded from actual inventory.', 'SO-000001', 'INV/26-27/0001', 'Acme Ltd', 'MOCK-WC-1', 'Partially Invoiced'), 'register rows')
    await waitFor(bodyHasAllCI('Pending invoice quantity (PCS)', 'Sales order quantity (PCS)', 'Released quantity (PCS)'), 'totals')
    assert(await evaluate(`Boolean(document.querySelector('[data-testid=pending-invoice-table] a[href="/sales/orders/so1"]')) && Boolean(document.querySelector('[data-testid=pending-invoice-table] a[href="/billing/invoices/inv2"]'))`),
      'sales order / invoice not linked')
    for (const f of readdirSync(downloadDir)) rmSync(path.join(downloadDir, f), { force: true })
    await click('button', 'Export to Excel')
    let file
    for (let i = 0; i < 50 && !file; i++) { await sleep(100); file = readdirSync(downloadDir).find((f) => f.startsWith('pending-invoice-register-') && f.endsWith('.xlsx')) }
    assert(file, 'register export not downloaded')
    const sheet = XLSX.utils.sheet_to_json(XLSX.read(readFileSync(path.join(downloadDir, file))).Sheets[XLSX.read(readFileSync(path.join(downloadDir, file))).SheetNames[0]], { header: 1 })
    assert(sheet[1][sheet[0].indexOf('Pending Invoice Qty')] === 2 && sheet[1][sheet[0].indexOf('Invoice No.')] === 'INV/26-27/0001', JSON.stringify(sheet.slice(0, 2)))
    await screenshot('pending-invoice-register')
    // Reports use the same figures.
    await click('[role=group] button', 'Partial invoices')
    await waitFor(bodyHasAllCI('Previously invoiced', 'Remaining at posting', 'Smoke Tester'), 'partial invoice report')
    await click('[role=group] button', 'Sales order vs invoice')
    await waitFor(bodyHasAllCI('On drafts', 'Dispatched'), 'reconciliation report')
    await click('[role=group] button', 'Customer-wise pending')
    await waitFor(bodyHasAllCI('Sales orders', 'Acme Ltd'), 'customer report')
    // Release the 2 PCS.
    await click('[role=group] button', 'Pending invoice quantity')
    await waitFor(`document.querySelector('[data-testid=pending-invoice-table] button')`, 'release button')
    await click('[data-testid=pending-invoice-table] button', 'Release')
    await waitFor(`document.querySelector('[data-testid=release-dialog]')`, 'release dialog')
    assert(await evaluate(`document.querySelector('#rel-qty').value === '2'`), 'releasable quantity not prefilled')
    await click('[role=dialog] button', 'Release')
    await waitFor(bodyHas('Give the reason for the release'), 'reason required')
    assert(rpcCalls('sales_order_line_release_pending').length === 0, 'released without a reason')
    await fill('#rel-reason', 'Customer no longer needs them')
    await click('[role=dialog] button', 'Release')
    await waitFor(bodyHasAllCI('Released 2 PCS of MOCK-WC-1 on SO-000001', 'No stock was moved', 'No pending invoice quantities'), 'released')
    const r = rpcCalls('sales_order_line_release_pending').at(-1).body
    assert(r.p_line_id === 'sol1' && r.p_quantity === 2 && r.p_reason === 'Customer no longer needs them' && /^[0-9a-f-]{36}$/.test(r.p_idempotency_key), JSON.stringify(r))
    assert(!requests.some((x) => x.path.startsWith('/rest/v1/rpc/inventory_review') || x.path === '/rest/v1/rpc/goods_receipt_direct_post'), 'a stock posting was called')
    await click('[role=group] button', 'Released quantities')
    await waitFor(bodyHasAllCI('Customer no longer needs them', 'Released by'), 'released report')
  } finally { pendingReleased = false }
})

await step('invoice print: A4 layout from snapshots, amount in words, browser PDF note, no draft watermark when issued', async () => {
  await goto('/billing/invoices/inv2/print')
  await waitFor(bodyHasAll('TAX INVOICE', 'INV/26-27/0001'), 'print page')
  for (const text of ['Amount in words', 'Save as PDF', '27AAAAA0000A1Z5', '27BBBBB0000B1Z5', '6910']) assert(await evaluate(bodyHas(text)), `missing "${text}"`)
  assert(!(await evaluate(bodyHas('Draft preview'))), 'issued invoice shown as draft')
  assert(!(await evaluate(bodyHas('do not reconcile'))), 'totals do not reconcile')
  await screenshot('52-invoice-print')
})

await step('record payment: validation before sending; allocation sent as exact strings; success after the server', async () => {
  await goto('/billing/payments?customer=cu1&invoice=inv2')
  await waitFor(`document.querySelector('#rp-amount')`, 'record payment dialog')
  await waitFor(bodyHas('INV/26-27/0001'), 'open invoices listed')
  await fill('#rp-amount', '500')
  await click('[role=dialog] button', 'Record receipt')
  await waitFor(bodyHas('Select the payment method'), 'method required')
  assert(rpcCalls('customer_payment_record').length === 0, 'sent without a method')
  await choose('#rp-method', 'UPI')
  await fill('[aria-label="Allocate to INV/26-27/0001"]', '600')
  await click('[role=dialog] button', 'Record receipt')
  await waitFor(bodyHas('Allocations exceed the amount received'), 'over-allocation blocked')
  assert(rpcCalls('customer_payment_record').length === 0, 'sent an over-allocation')
  await fill('[aria-label="Allocate to INV/26-27/0001"]', '500')
  await fill('#rp-ref', 'UPI-REF-1')
  await click('[role=dialog] button', 'Record receipt')
  await waitFor(bodyHas('Receipt RCT/26-27/0002 recorded'), 'receipt result')
  const calls = rpcCalls('customer_payment_record')
  assert(calls.length === 1, `expected one receipt, got ${calls.length}`)
  const b = calls[0].body
  assert(b.p_payment.customer_id === 'cu1' && b.p_payment.amount === '500' && b.p_payment.payment_method === 'UPI' && b.p_payment.transaction_reference === 'UPI-REF-1'
    && b.p_allocations.length === 1 && b.p_allocations[0].invoice_id === 'inv2' && b.p_allocations[0].amount === '500' && /^[0-9a-f-]{36}$/.test(b.p_idempotency_key), JSON.stringify(b))
  assert(await evaluate(bodyHas('not bank-verified')), 'unverified notice missing')
})

await step('receivables, ageing, statements, tax summary, reports and settings render real data', async () => {
  const pages = [
    ['/billing/invoices', 'Drafts & approval'], ['/billing/register', 'INV/26-27/0001'], ['/billing/allocations', 'RCT/26-27/0001'], ['/billing/receivables', 'INV/26-27/0001'],
    ['/billing/ageing', 'Customer × bucket'], ['/billing/statements?customer=cu1', 'STATEMENT OF ACCOUNT'], ['/billing/tax-summary', 'not GST returns'],
    ['/billing/reports', 'Invoice register'], ['/billing/credit-notes', 'No credit notes'], ['/billing/debit-notes', 'No debit notes'], ['/billing/settings', 'Not configured'],
  ]
  for (const [p, text] of pages) {
    await goto(p)
    await waitFor(bodyHas(text), `${p} shows "${text}"`)
    assert(!(await evaluate(bodyHas("You don't have permission"))), `${p} denied`)
  }
  await goto('/billing/tax-summary')
  await waitFor(bodyHasAll('HSN / SAC summary', '6910'), 'HSN summary rows')
  const reports = new Set(rpcCalls('billing_report').map((c) => c.body.p_report))
  for (const r of ['TAX_COMPONENTS', 'BY_GST_RATE', 'HSN_SUMMARY', 'INVOICES']) assert(reports.has(r), `report ${r} not requested`)
  await goto('/billing/statements?customer=cu1')
  await waitFor(bodyHasAll('Closing balance', 'UTR123'), 'statement entries')
  await screenshot('53-statement')
})

// V2 Stage 6: invoicing, GST, payments and Excel import
await step('invoice dashboard: all figures, GST summary, overdue list, trend; payment filter sent', async () => {
  await goto('/billing/dashboard')
  await waitFor(bodyHasAll('Invoice Dashboard', 'Total invoices', 'Created today', 'Issued this month', 'Taxable Sales', 'Total GST', 'Amount received (incl. GST)', 'Outstanding Receivables (Excl. GST)',
    'Overdue', 'Partially paid', 'Fully paid', 'Drafts', 'Cancelled'), 'KPI labels')
  await waitFor(bodyHasAll('12,000.00', '1 part-paid invoice(s)', 'GST summary', '18%', 'Overdue invoices', 'Monthly trend', 'INV/26-27/0001', 'Nothing is filed', 'excluding GST'), 'figures')
  assert(!(await evaluate(bodyHas('2,54,380.50'))), 'GST-inclusive invoice value still shown')
  await choose('#id-pay', 'Overdue')
  for (let i = 0; i < 50 && rpcCalls('invoice_dashboard').at(-1).body.p_payment_status !== 'OVERDUE'; i++) await sleep(100)
  assert(rpcCalls('invoice_dashboard').at(-1).body.p_payment_status === 'OVERDUE', 'payment filter not sent')
  await screenshot('invoice-dashboard')
})

await step('manual invoice: validation, product with discount, GST and freight, live total; saved and issued once', async () => {
  await goto('/billing/invoices/new?mode=manual')
  await waitFor(`!!document.querySelector('#inv-customer')`, 'entry form')
  await waitFor(bodyHasAll('Manual invoice', 'From sales order', 'Invoice details', 'Save and issue'), 'manual mode')
  await click('button[type=submit]', 'Save draft')
  await waitFor(bodyHasAll('Choose the customer.', 'Add at least one product.'), 'validation')
  assert(rpcCalls('sales_invoice_v2_save').length === 0, 'saved an empty invoice')
  await choose('#inv-customer', 'ACME')
  await choose('#inv-pos', 'Maharashtra')
  await fill('#inv-p-0', 'MOCK-WC-1')
  await press('#inv-p-0')
  await waitFor(`!!document.querySelector('input[aria-label="Quantity line 1"]') && document.body.innerText.includes('PCS')`, 'product chosen')
  await fill('input[aria-label="Quantity line 1"]', '2')
  await fill('input[aria-label="Rate line 1"]', '1000')
  await fill('input[aria-label="Discount line 1"]', '10')
  await choose('[aria-label="GST line 1"]', '18%')
  await fill('#inv-freight', '200')
  await fill('#inv-eway', '123')
  // 2 x 1000 - 10% = 1800 + 9% + 9% = 2124; freight 200 + 18% = 236 -> 2360
  await waitFor(`document.querySelector('[data-testid=inv-grand-total]').textContent.includes('2,360')`, 'live grand total')
  await click('button', 'Save and issue')
  await waitFor(bodyHas('An e-way bill number has 12 digits.'), 'e-way bill validation')
  assert(rpcCalls('sales_invoice_v2_save').length === 0, 'saved with a bad e-way bill')
  await fill('#inv-eway', '123456789012')
  await screenshot('invoice-entry-manual')
  await click('button', 'Save and issue')
  await waitFor(`location.pathname === '/billing/invoices/inv1'`, 'invoice page')
  await waitFor(bodyHas('Invoice INV/26-27/0003 issued'), 'issued notice')
  const s = rpcCalls('sales_invoice_v2_save').at(-1).body
  assert(s.p_invoice_id === null && s.p_header.customer_id === 'cu1' && s.p_header.sales_order_id === null && s.p_header.place_of_supply_state_code === '27'
    && s.p_header.eway_bill_number === '123456789012' && s.p_header.is_proforma === false && s.p_lines.length === 1 && s.p_lines[0].product_id === 'p1'
    && s.p_lines[0].quantity === '2' && s.p_lines[0].unit_price === '1000' && s.p_lines[0].discount_percent === '10' && s.p_lines[0].gst_rate === '18'
    && s.p_charges.freight === '200' && /^[0-9a-f-]{36}$/.test(s.p_idempotency_key), JSON.stringify(s))
  assert(rpcCalls('sales_invoice_v2_save').length === 1 && rpcCalls('sales_invoice_v2_issue').at(-1).body.p_invoice_id === 'inv1', 'saved or issued more than once')
})

await step('invoice from a sales order: ordered / invoiced / pending shown; over-invoicing refused; partial quantity saved with the order line', async () => {
  const before = rpcCalls('sales_invoice_v2_save').length
  await goto('/billing/invoices/new?mode=so&so=so1')
  await waitFor(bodyHasAll('Invoice from a sales order', 'Ordered 10 · invoiced 4 · pending 6 PCS'), 'order lines loaded')
  assert(await evaluate(`document.querySelector('input[aria-label="Quantity line 1"]').value === '6'`), 'pending quantity not prefilled')
  await fill('input[aria-label="Quantity line 1"]', '8')
  await click('button[type=submit]', 'Save draft')
  await waitFor(bodyHas('only 6 PCS of the sales order is left to invoice'), 'over-invoicing blocked')
  assert(rpcCalls('sales_invoice_v2_save').length === before, 'saved an over-invoice')
  await fill('input[aria-label="Quantity line 1"]', '3')
  await click('button[type=submit]', 'Save draft')
  await waitFor(`location.pathname === '/billing/invoices/inv1'`, 'invoice page')
  await waitFor(bodyHas('Draft invoice created'), 'draft notice')
  const s = rpcCalls('sales_invoice_v2_save').at(-1).body
  assert(s.p_header.sales_order_id === 'so1' && s.p_header.customer_id === 'cu1' && s.p_lines[0].sales_order_line_id === 'sol1' && s.p_lines[0].quantity === '3'
    && s.p_lines[0].unit_price === '950', JSON.stringify(s))
})

await step('invoice page: payment with excess kept as advance, then a one-step credit note; balances from the server', async () => {
  await goto('/billing/invoices/inv2')
  await waitFor(bodyHasAll('INV/26-27/0001', 'Record payment', 'Apply advance', 'Credit note', 'Debit note', 'Attachments'), 'issued invoice actions')
  await click('button', 'Record payment')
  await waitFor(`!!document.querySelector('#pay-amount')`, 'payment dialog')
  assert(await evaluate(`document.querySelector('#pay-amount').value === '1121'`), 'balance not prefilled')
  await fill('#pay-amount', '1200')
  await waitFor(bodyHas('will stay on the customer'), 'advance notice')
  await fill('#pay-ref', 'UTR-778')
  await click('[role=dialog] button', 'Record payment')
  await waitFor(bodyHasAll('Receipt RCT/26-27/0003', 'kept as an advance'), 'payment result with warning')
  const p = rpcCalls('invoice_v2_record_payment').at(-1).body
  assert(p.p_invoice_id === 'inv2' && p.p_payment.amount === '1200' && p.p_payment.payment_method === 'BANK_TRANSFER' && p.p_payment.transaction_reference === 'UTR-778'
    && p.p_payment.bank_reference.includes('50200012345678') && /^[0-9a-f-]{36}$/.test(p.p_idempotency_key), JSON.stringify(p))
  await click('button', 'Credit note')
  await waitFor(`!!document.querySelector('#note-text')`, 'note dialog')
  await click('[role=dialog] button', 'Issue credit note')
  await waitFor(bodyHas('Describe the reason'), 'note validation')
  await fill('#note-text', 'Two pieces broken in transit')
  await fill('input[aria-label="Quantity line 1"]', '1')
  await click('[role=dialog] button', 'Issue credit note')
  await waitFor(bodyHas('Credit note CN/26-27/0001 issued'), 'note issued')
  const n = rpcCalls('adjustment_note_v2_issue').at(-1).body
  assert(n.p_invoice_id === 'inv2' && n.p_type === 'CREDIT' && n.p_header.reason_code === 'SALES_RETURN' && n.p_lines[0].invoice_line_id === 'il2' && n.p_lines[0].quantity === '1', JSON.stringify(n))
  await screenshot('invoice-payment-credit-note')
})

await step('proforma: printed as PROFORMA INVOICE (never tax invoice); converted and issued in one step', async () => {
  tables.sales_invoice_list.push(invRow('inv3', null, 'DRAFT', { is_proforma: true, proforma_number: 'PFI-000001', source: 'MANUAL', vehicle_number: 'MH12AB1234', eway_bill_number: '123456789012' }))
  tables.sales_invoice_lines.push(invLine('il3', 'inv3'))
  try {
    await goto('/billing/invoices/inv3/print')
    await waitFor(bodyHasAll('PROFORMA INVOICE', 'PFI-000001', 'Amount in words', 'Bank details', '50200012345678', 'Director', 'MH12AB1234', '123456789012'), 'proforma print')
    assert(!(await evaluate(bodyHas('TAX INVOICE'))), 'proforma shown as a tax invoice')
    await screenshot('proforma-print')
    await goto('/billing/invoices/inv3')
    await waitFor(bodyHasAll('Convert to tax invoice and issue', 'Edit proforma'), 'proforma actions')
    await click('button', 'Convert to tax invoice and issue')
    await waitFor(`document.querySelector('[role=alertdialog]')`, 'confirm')
    await click('[role=alertdialog] button', 'Convert and issue')
    await waitFor(bodyHas('Proforma PFI-000001 converted. Invoice INV/26-27/0003 issued'), 'converted')
    assert(rpcCalls('sales_invoice_v2_issue').at(-1).body.p_convert_proforma === true, 'conversion flag not sent')
  } finally {
    tables.sales_invoice_list.splice(tables.sales_invoice_list.findIndex((r) => r.id === 'inv3'), 1)
    tables.sales_invoice_lines.splice(tables.sales_invoice_lines.findIndex((r) => r.id === 'il3'), 1)
  }
})

await step('invoice import: template columns, rows grouped by invoice number, errors held back, import after confirming, recorded in Bulk Operations', async () => {
  for (const f of readdirSync(downloadDir)) rmSync(path.join(downloadDir, f), { force: true })
  await goto('/billing/register')
  await waitFor(bodyHasAll('New invoice', 'Import'), 'register buttons')
  await choose('#rg-type', 'Tax invoice')
  for (let i = 0; i < 50 && !requests.some((r) => r.path === '/rest/v1/sales_invoice_list' && r.query.includes('invoice_type=eq.TAX_INVOICE')); i++) await sleep(100)
  assert(requests.some((r) => r.path === '/rest/v1/sales_invoice_list' && r.query.includes('invoice_type=eq.TAX_INVOICE')), 'type filter not applied')
  await click('main a[href="/billing/invoices/import"]')
  await waitFor(`location.pathname === '/billing/invoices/import'`, 'import page')
  await waitFor(bodyHas('Download template'), 'import page loaded')
  await click('button', 'Download template')
  let file
  for (let i = 0; i < 50 && !file; i++) { await sleep(100); file = readdirSync(downloadDir).find((f) => f === 'invoice-import-template.xlsx') }
  assert(file, 'template not downloaded')
  const header = XLSX.utils.sheet_to_json(XLSX.read(readFileSync(path.join(downloadDir, file))).Sheets.Invoices, { header: 1 })[0]
  assert(header.join('|') === 'Invoice Number|Invoice Date|Due Date|Customer Name|Customer GSTIN|Sales Order Number|Product SKU|Product Name|HSN Code|Quantity|Unit|Rate|Discount|GST Rate|Place of Supply|Payment Terms|Remarks',
    'wrong template ' + JSON.stringify(header))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header,
    ['OLD-1001', TODAY, '', 'Acme Ltd', '', '', 'MOCK-WC-1', 'Mock Closet 1', '6910', 1, 'PCS', 950, '', 18, '27', '30 days', ''],
    ['old-1001', TODAY, '', 'Acme Ltd', '', '', 'MOCK-WC-1', 'Mock Closet 1', '6910', 1, 'PCS', 950, '', 18, '27', '30 days', ''],
    ['OLD-1002', TODAY, '', 'Acme Ltd', '', '', 'NOPE-9', '', '', 1, '', 10, '', 18, '', '', ''],
  ]), 'Invoices')
  const filePath = path.join(outDir, 'invoice-import.xlsx')
  writeFileSync(filePath, XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }))
  await setFile(filePath)
  await waitFor(bodyHasAll('Missing customers and products', 'Add product NOPE-9', 'rows 2, 3', 'held back'), 'preview')
  const pv = rpcCalls('invoice_import_preview').at(-1).body
  assert(pv.p_rows.length === 3 && pv.p_rows[1].invoice_number === 'OLD-1001' && pv.p_rows[0].row_number === 2 && pv.p_rows[0].rate === '950', JSON.stringify(pv.p_rows))
  assert(rpcCalls('invoice_import').length === 0, 'imported before confirming')
  await screenshot('invoice-import-preview')
  await click('button', 'Import 1 invoice(s)')
  await waitFor(bodyHas('Import 1 invoice(s)?'), 'confirmation')
  await click('[role=alertdialog] button', 'Import')
  await waitFor(bodyHasAll('1 invoice(s) imported and issued, 1 invoice(s) not imported', 'Imported OLD-1001', 'Bulk Operations'), 'summary')
  const im = rpcCalls('invoice_import').at(-1).body
  assert(im.p_rows.length === 3 && im.p_file.file_name === 'invoice-import.xlsx' && /^[0-9a-f-]{36}$/.test(im.p_idempotency_key), JSON.stringify(im.p_file))
})

await step('invoice settings: GST rates, rounding, PDF and bank accounts saved through the server', async () => {
  await goto('/billing/settings')
  await waitFor(bodyHasAll('GST and invoice defaults', 'Invoice PDF', 'Bank accounts (receiving payments)', 'Default payment mode'), 'new settings sections')
  await choose('#st-rm', 'Always up')
  await fill('#st-rates', '0, 3, 5, 12, 18, 28')
  await fill('#st-sig', 'Managing Director')
  await click('button', 'Save settings')
  await waitFor(bodyHas('Settings saved'), 'saved')
  const ch = rpcCalls('billing_settings_update').at(-1).body.p_changes
  assert(ch.rounding_mode === 'UP' && JSON.stringify(ch.gst_rates) === '[0,3,5,12,18,28]' && ch.authorized_signatory === 'Managing Director', JSON.stringify(ch))
})

// V2 Stage 7: management overview, module dashboards, search, reports, activity, reconciliation, settings
await step('management dashboard: nine figures, period filter (today / week / month / year / custom), charts and lists; no quick actions', async () => {
  await goto('/')
  const metrics = ['Total stock', 'Manufactured stock', 'Outsourced stock', 'Purchase orders', 'Pending GRNs', 'Production orders', 'Sales orders', 'Taxable Sales', 'Outstanding Receivables (Excl. GST)']
  await waitFor(bodyHasAll('Management Dashboard', ...metrics), 'metrics')
  const card = (id) => evaluate(`document.querySelector('[data-testid=${id}]')?.innerText ?? ''`)
  // Stock split from inventory_overview (in-house = manufactured, outsourced); never invented.
  assert((await card('kpi-total-stock')).includes('140 PCS'), await card('kpi-total-stock'))
  assert((await card('kpi-manufactured-stock')).includes('100 PCS'), await card('kpi-manufactured-stock'))
  assert((await card('kpi-outsourced-stock')).includes('40 PCS'), await card('kpi-outsourced-stock'))
  assert(/\b2\b/.test(await card('kpi-purchase-orders')) && (await card('kpi-purchase-orders')).includes('1 open'), await card('kpi-purchase-orders'))
  assert((await card('kpi-pending-grns')).includes('₹178.00 still to receive (excl. GST)'), await card('kpi-pending-grns'))
  assert((await card('kpi-sales-orders')).includes('₹27,000.00 (excl. GST)'), await card('kpi-sales-orders'))
  assert((await card('kpi-invoiced-sales')).includes('₹12,000.00'), await card('kpi-invoiced-sales'))
  assert((await card('kpi-purchase-orders')).includes('Taxable Purchases ₹3,780.00'), await card('kpi-purchase-orders'))
  assert((await card('kpi-total-stock')).includes('Stock Value (Excl. GST) ₹2,800.00'), await card('kpi-total-stock'))
  assert((await card('kpi-outstanding')).includes('Outstanding Payables (Excl. GST) ₹3,780.00') && (await card('kpi-outstanding')).includes('1 part-paid invoice(s)'), await card('kpi-outstanding'))
  for (const t of ['Sales orders booked', 'Production output', 'Stock movement', 'Stock by source', 'Taxable sales invoiced', 'Purchases ordered vs received', 'Needs attention', 'Low stock', 'Customer balances']) {
    assert(await evaluate(bodyHas(t)), `missing "${t}"`)
  }
  // Legacy widgets are gone.
  for (const t of ['Quick actions', 'Business figures', 'Add Supplier', 'Record Payment']) assert(!(await evaluate(bodyHas(t))), `legacy "${t}" still shown`)
  assert(!(await evaluate(`!!document.querySelector('[data-testid=alert-OUT_OF_STOCK]')`)), 'an alert with nothing to report is shown')
  const first = rpcCalls('management_overview').at(-1).body
  assert(first.p_from === `${TODAY.slice(0, 7)}-01` && first.p_to === TODAY, JSON.stringify(first))
  await screenshot('v2-management-dashboard')
  // Period filter: each preset shows its period. A preset whose period equals the one already shown (e.g. "Today" on the
  // 1st of a month, "This Week" on a Monday) rightly needs no new request, so the check is on the period, not the count.
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const monday = new Date(`${TODAY}T00:00:00`); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  for (const [label, from] of [['Today', TODAY], ['This Week', iso(monday)], ['This Year', `${TODAY.slice(0, 4)}-01-01`]]) {
    await click('[aria-label="Date range"] button', label)
    for (let i = 0; i < 50; i++) {
      const last = rpcCalls('management_overview').at(-1).body
      if (last.p_from === from && last.p_to === TODAY) break
      await sleep(100)
    }
    const last = rpcCalls('management_overview').at(-1).body
    assert(last.p_from === from && last.p_to === TODAY, `${label}: shows ${JSON.stringify(last)}, expected ${from} to ${TODAY}`)
  }  await click('[aria-label="Date range"] button', 'Custom Range')
  await waitFor(`!!document.querySelector('#range-from')`, 'custom range form')
  assert(await evaluate(`[...document.querySelectorAll('[aria-label="Date range"] button')].map((b) => b.innerText.trim()).join('|') === 'Today|This Week|This Month|This Year|Custom Range'`), 'presets')
  await click('button', 'Cancel')
  await waitFor(`!document.querySelector('#range-from')`, 'custom range closed')
  // Cards and alerts open the records.
  await click('[data-testid=alert-PURCHASE_OVERDUE] a')
  await waitFor(`location.pathname === '/purchase-orders'`, 'alert opens purchase orders')
  await goto('/')
  await waitFor(bodyHas('Pending GRNs'), 'dashboard again')
  await click('[data-testid=kpi-pending-grns]')
  await waitFor(`location.pathname === '/drilldown/purchase.open' && location.search.includes('via=management')`, 'pending GRNs opens the open purchase orders behind it')
  // Phone width: no horizontal scroll.
  await setViewport(390, 844)
  await goto('/')
  await waitFor(bodyHas('Outstanding Receivables (Excl. GST)'), 'mobile dashboard')
  assert(await noHorizontalScroll(), 'mobile: dashboard scrolls horizontally')
  await screenshot('v2-management-dashboard-mobile')
  await cdp('Emulation.clearDeviceMetricsOverride')
})

await step('Total Stock valuation: unit cost and stock value columns, Not Valued, server summary cards, search, sorting, columns, export, product stock card', async () => {
  const th = `[...document.querySelectorAll('[data-testid=drill-table] th')].map((t) => t.innerText.trim().toLowerCase())`
  const rowText = (sku) => `([...document.querySelectorAll('[data-testid=drill-table] tbody tr')].find((tr) => tr.innerText.includes(${JSON.stringify(sku)}))?.innerText ?? '')`
  const cardText = (id) => evaluate(`document.querySelector('[data-testid=${id}]')?.innerText.replace(/\\s+/g, ' ') ?? ''`)
  const lastQuery = (p) => decodeURIComponent((requests.filter((r) => r.path === p).at(-1)?.query ?? '').split('+').join(' '))
  await goto('/')
  await waitFor(`!!document.querySelector('[data-testid=kpi-total-stock] a, a[data-testid=kpi-total-stock]')`, 'total stock card link')
  await click('[data-testid=kpi-total-stock] a, a[data-testid=kpi-total-stock]')
  await waitFor(`location.pathname === '/drilldown/inventory.on_hand' && !!document.querySelector('[data-testid=drill-table]')`, 'Total Stock drill-down')
  assert(lastQuery('/rest/v1/inventory_product_stock_value').includes('on_hand=neq.0'), lastQuery('/rest/v1/inventory_product_stock_value'))
  const heads = await evaluate(th)
  assert(JSON.stringify(heads) === JSON.stringify(['sku', 'product', 'category', 'unit', 'on hand', 'reserved', 'available', 'unit cost (₹)', 'stock value (excl. gst, ₹)', 'stock status']), JSON.stringify(heads))
  // 1 / 4: known cost (two lots: 100 @ 450 + 40 @ 480).  6: no cost -> Not Valued, never ₹0.
  await waitFor(`${rowText('MOCK-WC-1')}.includes('₹458.57') && ${rowText('MOCK-WC-1')}.includes('₹64,200.00')`, 'valued product row')
  const clay = await evaluate(rowText('MOCK-CLAY'))
  assert((clay.match(/Not Valued/g) ?? []).length === 2 && !clay.includes('₹0'), clay)
  // Summary cards from the server function.
  await waitFor(`document.querySelector('[data-testid=sv-value]')?.innerText.includes('₹64,200.00')`, 'summary cards')
  assert((await cardText('sv-products')).includes('2'), await cardText('sv-products'))
  assert((await cardText('sv-on-hand')).includes('140 PCS') && (await cardText('sv-on-hand')).includes('50 KG'), await cardText('sv-on-hand'))
  assert((await cardText('sv-reserved')).includes('10 PCS') && (await cardText('sv-available')).includes('130 PCS'), await cardText('sv-available'))
  assert((await cardText('sv-value')).includes('1 product(s) not fully valued'), await cardText('sv-value'))
  // Stock without a cost is shown apart (quantity), never in the value.
  assert((await cardText('sv-unvalued')).includes('50 KG') && !(await cardText('sv-unvalued')).includes('PCS'), await cardText('sv-unvalued'))
  await screenshot('180-total-stock-valuation')
  // 7. Search: the list and the summary use the same text.
  await fill('input[aria-label="Search records"]', 'clay')
  await waitFor(`document.querySelector('[data-testid=sv-products]')?.innerText.includes('1') && document.querySelector('[data-testid=sv-value]')?.innerText.includes('₹0.00')`, 'summary follows the search')
  assert(rpcCalls('inventory_stock_value_summary').at(-1).body.p_search === 'clay', JSON.stringify(rpcCalls('inventory_stock_value_summary').at(-1).body))
  assert(lastQuery('/rest/v1/inventory_product_stock_value').includes('ilike'), lastQuery('/rest/v1/inventory_product_stock_value'))
  await fill('input[aria-label="Search records"]', '')
  await waitFor(`document.querySelector('[data-testid=sv-value]')?.innerText.includes('₹64,200.00')`, 'search cleared')
  // Sorting by stock value and unit cost happens on the server.
  await click('[data-testid=drill-table] th button', 'Stock Value (Excl. GST')
  await waitFor(`new URLSearchParams(location.search).get('sort') === 'stock_value'`, 'sort by value')
  for (let t = Date.now(); !lastQuery('/rest/v1/inventory_product_stock_value').includes('order=stock_value.asc') && Date.now() - t < 5000;) await sleep(100)
  assert(lastQuery('/rest/v1/inventory_product_stock_value').includes('order=stock_value.asc.nullslast'), lastQuery('/rest/v1/inventory_product_stock_value'))
  await click('[data-testid=drill-table] th button', 'Stock Value (Excl. GST')
  await waitFor(`new URLSearchParams(location.search).get('sort') === '-stock_value'`, 'sort by value, highest first')
  await click('[data-testid=drill-table] th button', 'Unit Cost')
  await waitFor(`new URLSearchParams(location.search).get('sort') === 'unit_cost'`, 'sort by unit cost')
  await click('[data-testid=drill-table] th button', 'SKU')
  await waitFor(`new URLSearchParams(location.search).get('sort') === 'sku'`, 'SKU sort kept')
  // Columns selector lists the new columns; hiding one hides it.
  await click('button', 'Columns')
  await waitFor(`[...document.querySelectorAll('[role=dialog] label, [data-radix-popper-content-wrapper] label')].some((l) => l.innerText.includes('Unit Cost (₹)'))`, 'columns selector')
  assert(await evaluate(`[...document.querySelectorAll('[data-radix-popper-content-wrapper] label')].some((l) => l.innerText.includes('Stock Value (Excl. GST, ₹)'))`), 'value column not in the selector')
  await evaluate(`[...document.querySelectorAll('[data-radix-popper-content-wrapper] label')].find((l) => l.innerText.includes('Unit Cost (₹)')).querySelector('button').click()`)
  await waitFor(`!${th}.includes('unit cost (₹)')`, 'unit cost hidden')
  await evaluate(`[...document.querySelectorAll('[data-radix-popper-content-wrapper] label')].find((l) => l.innerText.includes('Unit Cost (₹)')).querySelector('button').click()`)
  await waitFor(`${th}.includes('unit cost (₹)')`, 'unit cost shown again')
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  // 10. Excel export carries the same values (numbers; Not Valued as text).
  for (const f of readdirSync(downloadDir)) rmSync(path.join(downloadDir, f), { force: true })
  await click('button', 'Export to Excel')
  let file
  for (let i = 0; i < 50 && !file; i++) { await sleep(100); file = readdirSync(downloadDir).find((f) => f.startsWith('Total-Units-on-Hand') && f.endsWith('.xlsx')) }
  assert(file, 'export not downloaded')
  const wb = XLSX.read(readFileSync(path.join(downloadDir, file)))
  const sheet = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })
  const h = sheet[0]
  const wc = sheet.find((r) => r[0] === 'MOCK-WC-1')
  const cl = sheet.find((r) => r[0] === 'MOCK-CLAY')
  assert(h.includes('Unit Cost (₹)') && h.includes('Stock Value (Excl. GST, ₹)'), JSON.stringify(h))
  assert(Math.abs(wc[h.indexOf('Unit Cost (₹)')] - 458.5714285714) < 0.0001 && wc[h.indexOf('Stock Value (Excl. GST, ₹)')] === 64200, JSON.stringify(wc))
  assert(cl[h.indexOf('Unit Cost (₹)')] === 'Not Valued' && cl[h.indexOf('Stock Value (Excl. GST, ₹)')] === 'Not Valued', JSON.stringify(cl))
  // Product stock card: average cost, total value, value per location and lot.
  await click('[data-testid=drill-table] a', 'MOCK-WC-1')
  await waitFor(`location.pathname === '/inventory/stock/p1'`, 'stock card')
  await waitFor(`document.querySelector('[data-testid=ps-avg-cost]')?.innerText.includes('₹458.57') && document.querySelector('[data-testid=ps-stock-value]')?.innerText.includes('₹64,200.00')`, 'average cost and value')
  await waitFor(bodyHasAll('₹45,000.00', '₹19,200.00', '₹450.00', '₹480.00'), 'each lot at its own cost')
  await screenshot('181-product-stock-valuation')
})

await step('global search: records (product, sales order) and modules; choosing a record opens it', async () => {
  await goto('/')
  await waitFor(`!!document.querySelector('input[aria-label="Search records and modules"]')`, 'header search')
  await fill('input[aria-label="Search records and modules"]', 'wc')
  await waitFor(bodyHasAll('MOCK-WC-1 — Mock Closet 1', 'SO-000001 — Acme Ltd'), 'record results')
  assert(rpcCalls('global_search').at(-1).body.p_term === 'wc', 'search term not sent')
  await evaluate(`[...document.querySelectorAll('[role=option]')].find((o) => o.innerText.includes('SO-000001')).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await waitFor(`location.pathname === '/sales/orders/so1'`, 'opened the sales order')
})

await step('module dashboards: products, ledger, purchase orders and goods received', async () => {
  const pages = [
    ['/products/dashboard', ['Product Master Dashboard', 'Total Products', 'Finished Goods', 'Raw Materials', 'Components', 'Outsourced Parts', 'Products Without BOM', 'Recently Added', 'Low Stock Products', 'MOCK-WC-2']],
    ['/ledger/dashboard', ['Ledger Dashboard', 'Total Customers', 'Total Suppliers', 'Customer and Supplier', 'Outstanding Receivables (Excl. GST)', 'Outstanding Payables (Excl. GST)', 'Outstanding Balances', 'Top customers', 'Top suppliers']],
    ['/purchase-orders/dashboard', ['Purchase Orders Dashboard', 'Total POs', 'Open POs', 'Partially Received POs', 'Fully Received POs', 'Pending Purchase Value', 'Overdue Deliveries', 'Top suppliers']],
    ['/goods-receipts/dashboard', ['Goods Received Dashboard', 'Total GRNs', 'GRNs Today', 'Monthly GRNs', 'Pending Receipts', 'Rejected Goods', 'Unlinked GRNs', 'Recently received items', '2 PCS']],
  ]
  for (const [p, texts] of pages) {
    await goto(p)
    await waitFor(bodyHasAll(...texts), `${p} figures`)
  }
  assert(['PRODUCTS', 'LEDGER', 'PURCHASE', 'GRN'].every((m) => rpcCalls('module_dashboard').some((c) => c.body.p_module === m)), 'not every dashboard queried')
  await screenshot('stage7-grn-dashboard')
})

await step('reports: 21 reports listed (incl. reorder planning); register with search, totals excluding cancelled, Excel export and print view', async () => {
  for (const f of readdirSync(downloadDir)) rmSync(path.join(downloadDir, f), { force: true })
  await goto('/reports')
  await waitFor(bodyHasAll('Reports', 'Product Master Report', 'Stock Register', 'Supplier Outstanding Report', 'Payment Collection Report'), 'report list')
  assert(await evaluate(`document.querySelectorAll('a[href^="/reports/view/"]').length === 21`), 'not 21 reports')
  await click('a', 'Sales Invoice Register')
  await waitFor(`location.pathname === '/reports/view/invoice_register'`, 'report page')
  await waitFor(bodyHasAll('INV/26-27/0001', 'INV/26-27/0009', 'Total', '2 row(s)'), 'rows')
  // Total grand_total counts the live invoice only (2242), not the cancelled one.
  assert(await evaluate(`[...document.querySelectorAll('tfoot td')].some((t) => t.innerText.includes('2,242.00'))`), 'total should exclude cancelled')
  const first = rpcCalls('erp_report_v2').at(-1).body
  assert(first.p_report === 'INVOICE_REGISTER' && first.p_filters.from === `${TODAY.slice(0, 7)}-01` && first.p_filters.to === TODAY, JSON.stringify(first))
  await fill('input[aria-label="Search report"]', 'beta')
  await waitFor(`(${bodyHas('1 row(s)')}) && !(${bodyHas('INV/26-27/0001')})`, 'search applied')
  assert(rpcCalls('erp_report_v2').at(-1).body.p_filters.search === 'beta', 'search not sent')
  await fill('input[aria-label="Search report"]', '')
  await waitFor(bodyHas('2 row(s)'), 'search cleared')
  await click('button', 'Excel')
  let file
  for (let i = 0; i < 50 && !file; i++) { await sleep(100); file = readdirSync(downloadDir).find((f) => f.startsWith('invoice-register-')) }
  assert(file, 'Excel not downloaded')
  const sheet = XLSX.utils.sheet_to_json(XLSX.read(readFileSync(path.join(downloadDir, file))).Sheets[XLSX.read(readFileSync(path.join(downloadDir, file))).SheetNames[0]], { header: 1 })
  assert(sheet[0][0] === 'Sales Invoice Register' && sheet.some((r) => r[0] === 'Invoice') && sheet.at(-1)[0] === 'Total', JSON.stringify(sheet.slice(0, 5)))
  assert(await evaluate(`!!document.querySelector('.print-area table')`), 'print view missing')
  await screenshot('stage7-report-invoice-register')
})

await step('ERP settings: company profile, date format and numbering saved through the server; errors shown', async () => {
  await goto('/admin/erp-settings')
  await waitFor(`!!document.querySelector('#es-name') && document.querySelector('#es-name').value === 'Test Co'`, 'company tab')
  for (const t of ['Company', 'Products', 'Inventory', 'Purchase', 'Production', 'Sales', 'Invoices', 'Excel import', 'Backup & audit', 'System']) {
    assert(await evaluate(`[...document.querySelectorAll('[role=tab]')].some((b) => b.innerText.trim() === ${JSON.stringify(t)})`), `tab ${t} missing`)
  }
  await fill('#es-pan', 'aaaaa0000a')
  await choose('#es-df', 'DD/MM/YYYY')
  await click('button', 'Save settings')
  await waitFor(bodyHas('Settings saved and recorded in the audit log.'), 'saved')
  const save1 = rpcCalls('erp_settings_save').at(-1).body
  assert(save1.p_company.pan === 'AAAAA0000A' && save1.p_settings['general.date_format'] === 'DD/MM/YYYY', JSON.stringify(save1))
  await click('[role=tab]', 'Products')
  await waitFor(`!!document.querySelector('[data-testid=import-match-key-setting] #es-match')`, 'match key setting')
  await choose('#es-match', 'Model Number')
  await waitFor(bodyHas('a model number used by several products is reported'), 'match key hint')
  await click('button', 'Save settings')
  await waitFor(bodyHas('Settings saved and recorded in the audit log.'), 'match key saved')
  assert(rpcCalls('erp_settings_save').at(-1).body.p_settings['product.import_match_key'] === 'MODEL_NUMBER', 'match key not saved')
  ERP_SETTINGS.settings['product.import_match_key'] = 'SKU'
  await click('[role=tab]', 'Purchase')
  await waitFor(`!!document.querySelector('#es-po')`, 'purchase tab')
  assert(await evaluate(bodyHas('Next: PO-000004')), 'next PO number not shown')
  await fill('#es-po', 'x')
  await click('button', 'Save settings')
  await waitFor(bodyHas('Number prefixes are 2 to 5 capital letters'), 'server error shown')
  await click('[role=tab]', 'Backup & audit')
  await waitFor(bodyHasAll('Database backups', 'does not show a backup status', 'Export inventory', 'Audit history'), 'backup tab')
  assert(!(await evaluate(bodyHas('Backup completed'))), 'claims a backup')
  await click('[role=tab]', 'System')
  await waitFor(bodyHas('Security & audit'), 'system tab keeps the earlier settings')
  ERP_SETTINGS.settings['general.date_format'] = 'DD MMM YYYY'
  await screenshot('stage7-erp-settings')
})

await step('navigation: every sidebar link opens a page (no 404, no crash)', async () => {
  const navSource = readFileSync(path.join(root, 'src', 'config', 'navigation.ts'), 'utf8')
  const paths = [...new Set([...navSource.matchAll(/^\s+path: '(\/[^']*)',/gm)].map((m) => m[1]))]
  // 59 V2 entries plus the 12 Accounts pages (Phase 0 and the Phase 1 journal pages).
  assert(paths.length >= 40 && paths.length <= 90, `expected the V2 navigation, found ${paths.length}`)
  const broken = []
  for (const p of paths) {
    await goto(p)
    await sleep(150)
    const bad = await evaluate(`(${bodyHas("We couldn't find that page")}) || [...document.querySelectorAll('button')].some((b) => b.innerText.includes('Reload page'))`)
    if (bad) broken.push(p)
  }
  assert(broken.length === 0, `broken links: ${broken.join(', ')}`)
  // Exactly the eight approved modules in the sidebar.
  await goto('/')
  await waitFor(`document.querySelectorAll('aside nav > div button[aria-expanded], aside nav > div p').length >= 9`, 'sidebar groups')
  const groups = await evaluate(`[...document.querySelectorAll('aside nav > div')].map((d) => (d.querySelector('button[aria-expanded], p')?.innerText ?? '').trim().toLowerCase())`)
  assert(groups.join('|') === ['Management Dashboard', 'Product Master & BOM', 'Inventory Management', 'Purchase & GRN', 'Production & Outsourcing', 'Sales & Orders', 'Billing & Invoicing', 'Ledger', 'Reports & Settings'].join('|').toLowerCase(), groups.join('|'))
  assert(!(await evaluate(bodyHas('Not built'))), '"Not built" label shown')
  // Removed legacy modules are not reachable; merged pages redirect to their V2 page.
  for (const p of ['/analytics', '/amazon', '/customer-pos', '/marketplace-orders', '/activity', '/reconciliation', '/admin/approvals', '/admin/barcodes', '/admin/documents', '/admin/system-health', '/admin/user-activity',
    '/inventory/counts', '/inventory/batches', '/inventory/reports', '/production/outsourcing', '/production/outsourced-receipts',
    '/sales/picking', '/sales/packing', '/sales/dispatch', '/sales/delivery', '/sales/returns', '/sales/reports', '/sales/order-details']) {
    await goto(p)
    await waitFor(bodyHas("We couldn't find that page"), `${p} removed`)
  }
  for (const [from, to] of [['/settings', '/admin/erp-settings'], ['/sales', '/sales/dashboard'], ['/billing', '/billing/dashboard'], ['/customers', '/ledger/customers'], ['/suppliers', '/ledger/suppliers'], ['/dashboard/inventory', '/inventory'], ['/production/analytics', '/production']]) {
    await goto(from)
    await waitFor(`location.pathname === ${JSON.stringify(to)}`, `${from} redirects to ${to}`)
  }
})

// ===========================================================================
await step('notifications: bell shows the unread count; centre lists, filters and marks read; email/push not configured', async () => {
  await goto('/notifications')
  await waitFor(bodyHasAll('Approval needed: ADJ-000001', 'Product import finished with rejected rows', 'Not configured'), 'notification centre')
  await waitFor(`document.querySelector('button[aria-label="Notifications (1 unread)"]')`, 'unread badge')
  assert(await evaluate(bodyHas('(always on)')), 'mandatory approval notifications not locked')
  await click('[role=tab], button', 'Unread')
  await waitFor(`!(${bodyHas('Product import finished with rejected rows')})`, 'unread filter')
  assert(requests.some((r) => r.path === '/rest/v1/notifications' && r.query.includes('read_at=is.null')), 'unread filter not sent to the server')
  await click('button', 'Mark all as read')
  await waitFor(bodyHas('All notifications marked as read.'), 'marked read')
  assert(rpcCalls('notifications_mark_read').at(-1).body.p_ids === null, 'mark-all not sent')
  await screenshot('70-notifications')
})

await step('bulk operations: import history, rejected rows and a downloadable error report', async () => {
  for (const f of readdirSync(downloadDir)) rmSync(path.join(downloadDir, f), { force: true })
  await goto('/admin/bulk-operations')
  await waitFor(bodyHasAll('products-oct.xlsx', 'Completed with errors'), 'history')
  await click('button', 'Details')
  await waitFor(bodyHasAll('GST rate must be one of', 'SKU already exists', 'Retry on import page'), 'rows')
  await click('[role=dialog] button', 'CSV')
  await sleep(1200)
  const file = readdirSync(downloadDir).find((f) => f.startsWith('products-errors') && f.endsWith('.csv'))
  assert(file, 'no error report downloaded')
  const csv = readFileSync(path.join(downloadDir, file), 'utf8')
  for (const t of ['Row,Outcome,Reference,Problems', 'BAD-1', 'Rejected', 'Duplicate']) assert(csv.includes(t), `report missing "${t}"`)
  assert(await evaluate(`[...document.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/products/import?retry=ij1')`), 'retry does not use the existing import page')
})

await step('ERP settings: changes are confirmed and saved through the existing company settings', async () => {
  await goto('/admin/erp-settings?tab=system')
  await waitFor(`document.querySelector('#es-mb') && document.querySelector('#es-mb').value === '10'`, 'current setting')
  await fill('#es-mb', '12')
  await click('button', 'Save changes')
  await waitFor(bodyHas('Maximum document size: 10 MB → 12 MB'), 'confirmation')
  assert(!requests.some((r) => r.path === '/rest/v1/company_settings' && r.method === 'PATCH'), 'saved before confirmation')
  await click('[role=alertdialog] button', 'Save')
  await waitFor(bodyHas('Settings saved.'), 'saved')
  const patch = requests.filter((r) => r.path === '/rest/v1/company_settings' && r.method === 'PATCH').at(-1)
  assert(patch && patch.body.setting_value === 12 && patch.query.includes('id=eq.cs1'), 'setting not saved through company_settings')
  assert(await evaluate(bodyHas('Not configured')), 'integration status missing')
})

await step('audit log viewer: server-side paging and filters; CSV export', async () => {
  for (const f of readdirSync(downloadDir)) rmSync(path.join(downloadDir, f), { force: true })
  await goto('/audit-logs')
  await waitFor(bodyHasAll('transaction number: TXN-000001', 'Access denied'), 'entries')
  const q = requests.filter((r) => r.path === '/rest/v1/audit_logs').at(-1).query
  assert(q.includes('offset=0') && q.includes('limit=50') && q.includes('event_timestamp=gte.'), `not server-paged: ${q}`)
  await choose('#al-module', 'Inventory')
  await sleep(500)
  assert(requests.filter((r) => r.path === '/rest/v1/audit_logs').at(-1).query.includes('action=like.inventory.'), 'module filter not sent')
  await click('button', 'Export CSV')
  await sleep(1200)
  const file = readdirSync(downloadDir).find((f) => f.startsWith('audit-log-') && f.endsWith('.csv'))
  assert(file, 'no CSV downloaded')
  assert(readFileSync(path.join(downloadDir, file), 'utf8').includes('Time (UTC),User,Action,Module'), 'CSV header missing')
  await screenshot('75-audit-log')
})

// ===========================================================================
// AMAZON SALES & PROFIT INTELLIGENCE
// ===========================================================================
const poCalls = (fn) => rpcCalls(fn).map((c) => c.body)
await step('purchase orders: dashboard figures and register come from the database; no "Not built" label', async () => {
  await goto('/purchase-orders')
  await waitFor(bodyHasAll('Total purchase orders', 'Outstanding receipt value', 'PO-000001', 'PO-000002', 'PO-000003'), 'po dashboard')
  assert(!(await evaluate(bodyHas('is not built in this version'))), 'purchase orders still marked not built')
  assert(!(await evaluate(`[...document.querySelectorAll('a[href="/purchase-orders"]')].some((a) => /not built/i.test(a.innerText))`)), 'sidebar still says not built')
  assert(poCalls('purchase_order_dashboard').length > 0, 'dashboard RPC not called')
  assert(await evaluate(bodyHas('8,496.00')), 'outstanding receipt value not shown')
  await choose('#f-status', 'Pending approval')
  await waitFor(`${bodyHas('PO-000002')} && !(${bodyHas('PO-000003')})`, 'status filter')
  await click('button', 'Clear filters')
  await fill('#f-product', 'clay')
  await waitFor(`${bodyHas('PO-000002')} && !(${bodyHas('PO-000001')})`, 'product filter')
  await click('button', 'Clear filters')
  await screenshot('93-purchase-orders')
})

await step('purchase orders: the new order form validates, previews GST and saves through the RPC', async () => {
  await click('a', 'New Purchase Order')
  await waitFor(`location.pathname === '/purchase-orders/new' && !!document.querySelector('#po-supplier')`, 'po form')
  await click('button[type=submit]', 'Save draft')
  await waitFor(bodyHasAll('Select a supplier.', 'Line 1: select a product.'), 'form errors')
  assert(poCalls('purchase_order_save_refs').length === 0, 'invalid order sent to the server')
  await choose('#po-supplier', 'SUP-000001')
  await waitFor(bodyHas('Intra-state: CGST + SGST'), 'tax treatment from GSTIN states')
  await fill('input[id$="-product"]', 'MOCK')
  await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('MOCK-WC-1'))`, 'product search')
  await click('[role=option]', 'MOCK-WC-1')
  await fill('input[id$="-qty"]', '10')
  await fill('input[id$="-price"]', '1000')
  await fill('input[id$="-discount"]', '10')
  await waitFor(bodyHas('10,620.00'), 'GST preview (9,000 + 810 + 810)')
  await fill('#po-invoice', 'SINV-900')
  await fill('#po-challan', 'SDC-900')
  await screenshot('94-po-form')
  await click('button[type=submit]', 'Save draft')
  await waitFor(`location.pathname === '/purchase-orders/po1'`, 'navigated to the saved order')
  await waitFor(bodyHas('PO-000001 created as a draft.'), 'saved notice')
  const save = poCalls('purchase_order_save_refs').at(-1)
  assert(save.p_po_id === null && save.p_header.supplier_id === 'sup1' && !('company_id' in save.p_header), 'wrong header (or client sent a company)')
  assert(save.p_lines.length === 1 && save.p_lines[0].product_id === 'p1' && save.p_lines[0].quantity === '10' && save.p_lines[0].unit_price === '1000'
    && save.p_lines[0].discount_percent === '10' && save.p_lines[0].gst_rate === '18', 'wrong lines: ' + JSON.stringify(save.p_lines))
  assert(/^[0-9a-f-]{36}$/.test(save.p_idempotency_key) && save.p_header.warehouse_id === 'w1', 'missing request id or default warehouse')
  assert(!('grand_total' in save.p_header) && !('line_total' in save.p_lines[0]), 'client sent calculated totals')
  assert(save.p_refs && save.p_refs.supplier_invoice_number === 'SINV-900' && save.p_refs.supplier_challan_number === 'SDC-900' && !('supplier_invoice_number' in save.p_header),
    'supplier references not sent separately from the order header ' + JSON.stringify(save.p_refs))
})

// The mock policy has segregation of duties ON, so this covers the fallback:
// your own draft is submitted for someone else, not opened in one step.
await step('purchase orders: with segregation on, own drafts are submitted not opened; rejecting needs a reason; approval goes through the RPC', async () => {
  assert(await evaluate(bodyHasAll('Edit draft', 'Submit for approval')), 'draft actions missing')
  assert(!(await evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Open order')`)), 'one-step open shown with segregation on')
  assert(!(await evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Approve')`)), 'approve shown on a draft')
  await goto('/purchase-orders/po2')
  await waitFor(bodyHasAll('PO-000002', 'Pending approval'), 'pending order')
  const before = poCalls('purchase_order_action').length
  await click('button', 'Reject')
  await waitFor(bodyHas('Reject purchase order?'), 'reject dialog')
  await click('[role=dialog] button[type=submit]')
  await waitFor(bodyHas('Enter the reason'), 'reason required')
  assert(poCalls('purchase_order_action').length === before, 'rejected without a reason')
  await click('[role=dialog] button', 'Back')
  await click('button', 'Approve')
  await waitFor(bodyHas('Approve purchase order?'), 'approve dialog')
  await click('[role=dialog] button[type=submit]')
  await waitFor(bodyHas('PO-000002: opened.'), 'opened notice')
  const call = poCalls('purchase_order_action').at(-1)
  assert(call.p_action === 'APPROVE' && call.p_po_id === 'po2' && call.p_expected_updated_at === '2026-10-20T10:00:00.123456+00:00', 'wrong approve call ' + JSON.stringify(call))
})

await step('purchase orders: goods receipt validates, posts once with a request id and reuses it on retry', async () => {
  await goto('/purchase-orders/po3')
  await waitFor(bodyHasAll('PO-000003', 'GRN-000001', 'TXN-000090', 'Record goods receipt'), 'sent order with a receipt')
  await click('button', 'Record goods receipt')
  await waitFor(`!!document.querySelector('#gr-pol3a-rec')`, 'receipt dialog')
  assert(!(await evaluate(`!!document.querySelector('#gr-pol3b-rec')`)), 'charge line offered for receipt')
  await fill('#gr-pol3a-rec', '4')
  await fill('#gr-pol3a-rej', '1')
  await waitFor(`document.querySelector('#gr-pol3a-acc').value === '3'`, 'accepted = received - rejected')
  await click('[role=dialog] button[type=submit]')
  await waitFor(bodyHas('enter the reason for the rejected'), 'rejection reason required')
  assert(poCalls('purchase_receipt_post_refs').length === 0, 'posted without a rejection reason')
  await fill('#gr-pol3a-reason', 'Cracked in transit')
  await fill('#gr-invoice', 'SINV-901')
  await fill('#gr-challan', 'SDC-31')
  failNext.add('purchase_receipt_post_refs')
  await click('[role=dialog] button[type=submit]')
  await waitFor(`[...document.querySelectorAll('[role=dialog] [role=alert]')].some((e) => e.innerText.includes('Something went wrong'))`, 'simulated failure shown')
  await click('[role=dialog] button[type=submit]')
  await waitFor(bodyHas('GRN-000002 posted: stock transactions TXN-000091.'), 'receipt posted')
  const [first, second] = poCalls('purchase_receipt_post_refs').slice(-2)
  assert(first.p_idempotency_key === second.p_idempotency_key, 'retry used a new request id (could post twice)')
  const l = second.p_lines[0]
  assert(second.p_lines.length === 1 && l.po_line_id === 'pol3a' && l.received_quantity === '4' && l.accepted_quantity === '3' && l.rejected_quantity === '1'
    && l.accepted_location_id === 'l1' && l.rejected_location_id === null && l.rejection_reason === 'Cracked in transit', 'wrong receipt payload ' + JSON.stringify(l))
  assert(second.p_header.supplier_invoice_number === 'SINV-901' && second.p_header.supplier_challan_number === 'SDC-31', 'GRN references missing ' + JSON.stringify(second.p_header))
})

await step('GRN actual purchase cost: PO price shown, actual cost editable, variance and value shown, reason required, large change warned, sent with the receipt', async () => {
  await goto('/purchase-orders/po3')
  await waitFor(bodyHas('Record goods receipt'), 'order')
  await click('button', 'Record goods receipt')
  await waitFor(`!!document.querySelector('#gr-pol3a-actual')`, 'receipt dialog with the actual cost')
  // Defaults to the PO price; no change, no reason asked.
  assert(await evaluate(`document.querySelector('#gr-pol3a-actual').value === '1000'`), 'actual cost does not default to the PO price')
  await fill('#gr-pol3a-rec', '4')
  await waitFor(`document.querySelector('[data-testid=gr-price-1]')?.innerText.includes('No change') && document.querySelector('[data-testid=gr-price-value-1]')?.innerText.includes('3,600')
    && document.querySelector('[data-testid=gr-price-payable-1]')?.innerText.includes('4,248')`, 'no change; value at PO cost after discount; payable = 4/10 of the order line total')
  assert(!(await evaluate(`!!document.querySelector('#gr-pol3a-price-reason')`)), 'reason asked for an unchanged price')
  assert(await evaluate(bodyHasAll('PO unit price', 'Actual Purchase Unit Cost (₹)', 'Price difference', 'Variance', 'Discount · GST', 'Accepted goods value', '10% · CGST 9% + SGST 9%')), 'pricing labels')
  // Actual ₹1,250 (+25%): difference, variance, increase, value after the 10% discount, warning, reason required.
  await fill('#gr-pol3a-actual', '1250')
  await waitFor(`document.querySelector('[data-testid=gr-price-diff-1]')?.innerText.includes('+₹250.00') && document.querySelector('[data-testid=gr-price-1]')?.innerText.includes('+25.00%')
    && document.querySelector('[data-testid=gr-price-1]')?.innerText.includes('Increase') && document.querySelector('[data-testid=gr-price-value-1]')?.innerText.includes('4,500')
    && document.querySelector('[data-testid=gr-price-payable-1]')?.innerText.includes('5,310')`, 'variance shown; payable 4 × 1,125 = 4,500 + CGST 405 + SGST 405 = 5,310')
  assert(await evaluate(`!!document.querySelector('[data-testid=gr-price-warning-1]')`), 'large change not warned')
  await screenshot('198-grn-actual-cost')
  const before = poCalls('purchase_receipt_post_refs').length
  await click('[role=dialog] button[type=submit]')
  await waitFor(bodyHas('select the reason for the price change'), 'reason required')
  assert(poCalls('purchase_receipt_post_refs').length === before, 'posted without a reason')
  await fill('#gr-pol3a-actual', '-5')
  await waitFor(bodyHas('not negative'), 'negative refused')
  await fill('#gr-pol3a-actual', '1250')
  await choose('#gr-pol3a-price-reason', 'Other')
  await click('[role=dialog] button[type=submit]')
  await waitFor(bodyHas('describe the reason for the price change (Other)'), 'Other needs a description')
  assert(poCalls('purchase_receipt_post_refs').length === before, 'posted Other without a description')
  await choose('#gr-pol3a-price-reason', 'Supplier price revision')
  await fill('#gr-pol3a-price-remark', 'Invoice SINV-902')
  const probesBefore = requests.filter((r) => r.path === '/rest/v1/goods_receipt_lines').length
  await click('[role=dialog] button[type=submit]')
  await waitFor(bodyHas('GRN-000002 posted'), 'posted (the result confirmed actual_cost_supported)')
  const l = poCalls('purchase_receipt_post_refs').at(-1).p_lines[0]
  assert(l.actual_unit_price === '1250' && l.price_variance_reason === 'Supplier price revision: Invoice SINV-902', 'price not sent ' + JSON.stringify(l))
  const probe = requests.findLastIndex((r) => r.path === '/rest/v1/goods_receipt_lines')
  const postAt = requests.findLastIndex((r) => r.path === '/rest/v1/rpc/purchase_receipt_post_refs')
  assert(requests.filter((r) => r.path === '/rest/v1/goods_receipt_lines').length === probesBefore + 1 && probe < postAt
    && decodeURIComponent(requests[probe].query).includes('select=po_unit_cost'), 'server support not checked before posting a changed price')
})

await step('GRN actual purchase cost: a changed price is never posted to a database without actual-cost support, and never reported as posted unless the server confirms it', async () => {
  try {
    // 1. Older database (column missing): a changed price is refused before anything is posted.
    GRN_COST_COLUMNS = false
    await goto('/purchase-orders/po3')
    await waitFor(bodyHas('Record goods receipt'), 'order')
    await click('button', 'Record goods receipt')
    await waitFor(`!!document.querySelector('#gr-pol3a-actual')`, 'receipt dialog')
    await fill('#gr-pol3a-rec', '2')
    await fill('#gr-pol3a-actual', '1100')
    await choose('#gr-pol3a-price-reason', 'Market price increase')
    const before = poCalls('purchase_receipt_post_refs').length
    await click('[role=dialog] button[type=submit]')
    await waitFor(`document.querySelector('[data-testid=gr-error]')?.innerText.includes('has not been updated for actual purchase costs')`, 'unsupported database refused')
    assert(poCalls('purchase_receipt_post_refs').length === before, 'a changed price was posted to a database without support')
    // An unchanged price still posts on the older database (existing behaviour).
    await fill('#gr-pol3a-actual', '1000')
    await click('[role=dialog] button[type=submit]')
    await waitFor(bodyHas('GRN-000002 posted'), 'unchanged price posted')
    assert(poCalls('purchase_receipt_post_refs').length === before + 1, 'unchanged price not posted')
    GRN_COST_COLUMNS = true

    // 2. The server posts but does not confirm actual_cost_supported: shown as an error, never as a success.
    GRN_COST_CONFIRMED = false
    await goto('/purchase-orders/po3')
    await waitFor(bodyHas('Record goods receipt'), 'order')
    await click('button', 'Record goods receipt')
    await waitFor(`!!document.querySelector('#gr-pol3a-actual')`, 'receipt dialog')
    await fill('#gr-pol3a-rec', '2')
    await fill('#gr-pol3a-actual', '1100')
    await choose('#gr-pol3a-price-reason', 'Market price increase')
    await click('[role=dialog] button[type=submit]')
    await waitFor(`document.querySelector('[data-testid=gr-error]')?.innerText.includes('did not confirm the actual purchase cost')`, 'unconfirmed posting shown as an error')
    assert(!(await evaluate(bodyHas('GRN-000002 posted'))), 'an unconfirmed posting was reported as a success')
    assert(await evaluate(`![...document.querySelectorAll('[role=dialog] button')].some((b) => b.innerText.includes('Post goods receipt'))`), 'could post again after an unconfirmed posting')
    await screenshot('200-grn-cost-not-confirmed')
    const sent = poCalls('purchase_receipt_post_refs').length
    await click('[role=dialog] button', 'Close')
    await waitFor(`!document.querySelector('#gr-pol3a-actual') && ${bodyHas('did not confirm the actual purchase cost')}`, 'error notice on the order page')
    assert(poCalls('purchase_receipt_post_refs').length === sent, 'closing posted again')
  } finally {
    GRN_COST_COLUMNS = true
    GRN_COST_CONFIRMED = true
  }
})

await step('GRN totals and HSN: per-line HSN from the Product Master, live quantity / taxable / CGST / SGST / IGST / total, a changed HSN is sent and announced; the same on receipts without a PO', async () => {
  // Against a PO: MOCK-WC-1 at ₹1,000 less 10%, 18% intra-state.
  await goto('/purchase-orders/po3')
  await waitFor(bodyHas('Record goods receipt'), 'order')
  await click('button', 'Record goods receipt')
  await waitFor(`document.querySelector('#gr-pol3a-hsn')?.value === '6910' && !!document.querySelector('[data-testid=grn-summary]')`, 'HSN from the Product Master and the summary')
  await fill('#gr-pol3a-rec', '4')
  const sum = (k) => `document.querySelector('[data-testid=grn-summary-${k}]')?.innerText`
  await waitFor(`${sum('qty')}.includes('4 PCS') && ${sum('taxable')}.includes('3,600.00') && ${sum('cgst')}.includes('324.00') && ${sum('sgst')}.includes('324.00')
    && ${sum('igst')}.includes('0.00') && ${sum('gst')}.includes('648.00') && ${sum('total')}.includes('4,248.00')`, 'live totals')
  // A different actual cost updates the totals at once (₹1,250 less 10% = ₹1,125 × 4 = ₹4,500 + 18% = ₹5,310).
  await fill('#gr-pol3a-actual', '1250')
  await waitFor(`${sum('taxable')}.includes('4,500.00') && ${sum('total')}.includes('5,310.00')`, 'totals follow the actual cost')
  await fill('#gr-pol3a-actual', '1000')
  // HSN: invalid refused; a different one is announced and sent.
  await fill('#gr-pol3a-hsn', '691')
  await waitFor(`document.querySelector('[data-testid=gr-hsn-note-1]')?.innerText.includes('4, 6 or 8 digits')`, 'invalid HSN shown')
  const before = poCalls('purchase_receipt_post_refs').length
  await click('[role=dialog] button[type=submit]')
  await waitFor(`document.querySelector('[data-testid=gr-error]')?.innerText.includes('HSN must be 4, 6 or 8 digits')`, 'invalid HSN refused')
  assert(poCalls('purchase_receipt_post_refs').length === before, 'posted with an invalid HSN')
  await fill('#gr-pol3a-hsn', '691010')
  await waitFor(`document.querySelector('[data-testid=gr-hsn-note-1]')?.innerText.includes('the Product Master HSN becomes 691010 when this receipt is posted')`, 'Product Master update announced')
  await screenshot('204-grn-totals-hsn')
  await click('[role=dialog] button[type=submit]')
  await waitFor(bodyHas('Product Master HSN updated: MOCK-WC-1 6910 → 691010'), 'posted, HSN update reported')
  assert(poCalls('purchase_receipt_post_refs').at(-1).p_lines[0].hsn_code === '691010', JSON.stringify(poCalls('purchase_receipt_post_refs').at(-1).p_lines[0]))

  // Unchanged HSN: nothing is sent (the server records the Product Master HSN).
  await goto('/purchase-orders/po3')
  await waitFor(bodyHas('Record goods receipt'), 'order')
  await click('button', 'Record goods receipt')
  await waitFor(`document.querySelector('#gr-pol3a-hsn')?.value === '6910'`, 'receipt dialog')
  await fill('#gr-pol3a-rec', '1')
  await click('[role=dialog] button[type=submit]')
  await waitFor(bodyHas('GRN-000002 posted'), 'posted')
  assert(poCalls('purchase_receipt_post_refs').at(-1).p_lines[0].hsn_code === null, 'an unchanged HSN was sent')

  // Without a PO: entered cost and GST rate, amounts per line and in the summary, HSN from the Product Master.
  await goto('/goods-receipts')
  await waitFor(bodyHas('Receive without PO'), 'register')
  await click('button', 'Receive without PO')
  await waitFor(`!!document.querySelector('#dr-prod-0')`, 'direct receipt dialog')
  await fill('#dr-prod-0', 'MOCK-WC-1')
  await sleep(500)
  await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('MOCK-WC-1'))`, 'product option')
  await click('[role=option]', 'MOCK-WC-1')
  await waitFor(`document.querySelector('input[id^="dr-hsn-"]')?.value === '6910'`, 'HSN from the Product Master')
  await fill('input[id^="dr-rec-"]', '3')
  await fill('input[id^="dr-cost-"]', '100')
  await fill('input[id^="dr-gst-"]', '18')
  await waitFor(`document.querySelector('[data-testid=dr-amounts-0]')?.innerText.includes('taxable ₹300.00') && document.querySelector('[data-testid=dr-amounts-0]')?.innerText.includes('total ₹354.00')
    && ${sum('qty')}.includes('3 PCS') && ${sum('cgst')}.includes('27.00') && ${sum('sgst')}.includes('27.00') && ${sum('total')}.includes('354.00')`, 'direct amounts and totals')
  await fill('input[id^="dr-hsn-"]', '73241000')
  await waitFor(`document.querySelector('[data-testid=dr-hsn-note-0]')?.innerText.includes('becomes 73241000')`, 'HSN change announced')
  await screenshot('205-direct-grn-totals-hsn')
  await click('[role=dialog] button[type=submit]')
  await waitFor(`location.pathname === '/goods-receipts/gr9'`, 'posted')
  const d = poCalls('goods_receipt_direct_post_refs').at(-1).p_lines[0]
  assert(d.hsn_code === '73241000' && d.unit_cost === '100' && d.gst_rate === '18', JSON.stringify(d))
  // Detail and print show the HSN column.
  await waitFor(`!!document.querySelector('[data-testid=grn-line-hsn]')`, 'GRN detail HSN column')
  await goto('/goods-receipts/gr1/print')
  await waitFor(`!!document.querySelector('[data-testid=grn-print-hsn]')`, 'print HSN column')
})

await step('GRN price variance report: KPIs exclude reversed GRNs, supplier-wise and product-wise views, line list with reasons', async () => {
  await goto('/goods-receipts')
  await waitFor(`!!document.querySelector('[data-testid=grn-price-variance]')`, 'price variance button')
  await click('[data-testid=grn-price-variance]')
  await waitFor(`location.pathname === '/goods-receipts/price-variance'`, 'report page')
  await waitFor(bodyHasAll('GRN price variance', 'Supplier-wise price changes', 'Product-wise price trend', 'GRN-000002', 'Supplier price revision', 'GRN-000003'), 'report')
  // 2 posted lines with recorded prices (1 up, 1 down) + 1 older line without; total variance = +900 − 50 = +₹850 (the reversed +₹450 is excluded).
  assert(await evaluate(`(() => { const t = document.querySelector('[data-testid=pv-kpis]').innerText; return t.includes('of 2 posted GRN lines with recorded prices') && t.includes('1 older lines not recorded') && t.includes('+₹850') })()`), 'KPIs')
  assert(await evaluate(bodyHasAll('₹5,310.00', '₹531.00')), 'payable snapshots shown')
  assert(await evaluate(`document.querySelector('[data-testid=pv-suppliers]').innerText.includes('Morbi Tiles LLP') && document.querySelector('[data-testid=pv-suppliers]').innerText.includes('+₹900')`), 'supplier-wise')
  assert(await evaluate(`document.querySelector('[data-testid=pv-products]').innerText.includes('MOCK-WC-1')`), 'product-wise')
  assert(!(await evaluate(bodyHas('GRN-000004'))), 'reversed GRN shown under Price changed')
  await screenshot('199-grn-price-variance')
  await click('[role=tab], button', 'All lines')
  await waitFor(bodyHasAll('GRN-000004', 'GRN-000001', 'Not recorded', 'Posted before prices were recorded'), 'all lines include the reversed GRN and the unrecorded older GRN')
})

await step('purchase orders: printable A4 order uses the saved snapshots and the company logo', async () => {
  await goto('/purchase-orders/po3/print')
  await waitFor(bodyHasAll('PURCHASE ORDER', 'PO-000003', 'Shree Clay Works Pvt Ltd', 'GSTIN: 27AAPFU0939F1ZV', 'Authorised signatory', 'Payment terms: 30 Days'), 'print layout')
  assert(await evaluate(`!!document.querySelector('img[src="/alton-logo.png"]')`), 'logo missing')
  assert(!(await evaluate(bodyHas('do not reconcile'))), 'totals do not reconcile')
  await screenshot('95-po-print')
})

await step('purchase references: shown on the order and GRN, editable later, printed, searchable and exported', async () => {
  await goto('/purchase-orders/po3')
  await waitFor(bodyHasAll('PO-000003', 'Supplier invoice no.', 'SINV-778', 'SDC-12', 'On goods receipts'), 'order references')
  await click('button[aria-label^="Edit supplier references"]')
  await waitFor(`!!document.querySelector('#ref-invoice')`, 'references dialog')
  assert(await evaluate(`document.querySelector('#ref-invoice').value === 'SINV-778'`), 'dialog not prefilled')
  await fill('#ref-invoice', 'SINV-779')
  await click('[role=dialog] button[type=submit]', 'Save')
  await waitFor(bodyHas('Supplier references of PO-000003 saved.'), 'saved notice')
  const set = poCalls('purchase_document_refs_set').at(-1)
  assert(set.p_purchase_order_id === 'po3' && set.p_goods_receipt_id === null && set.p_refs.supplier_invoice_number === 'SINV-779' && set.p_refs.supplier_challan_number === 'SDC-12', JSON.stringify(set))
  await goto('/purchase-orders/po3/print')
  await waitFor(bodyHasAll('PURCHASE ORDER', 'PO-000003', 'Your invoice no.: SINV-778', 'Your challan no.: SDC-12'), 'references on the printed order')
  await goto('/goods-receipts/gr1')
  await waitFor(bodyHasAll('GRN-000001', 'Supplier invoice and challan', 'SINV-778', 'DC-554', 'Print / PDF'), 'GRN references')
  await click('button[aria-label^="Edit supplier references"]')
  await waitFor(`!!document.querySelector('#ref-challan')`, 'GRN references dialog')
  await fill('#ref-challan', 'DC-555')
  await click('[role=dialog] button[type=submit]', 'Save')
  await waitFor(bodyHas('Supplier references of GRN-000001 saved.'), 'GRN saved notice')
  const g = poCalls('purchase_document_refs_set').at(-1)
  assert(g.p_goods_receipt_id === 'gr1' && g.p_purchase_order_id === null && g.p_refs.supplier_challan_number === 'DC-555', JSON.stringify(g))
  await click('a', 'Print / PDF')
  await waitFor(bodyHasAll('GOODS RECEIVED NOTE', 'GRN-000001', 'PO-000003', 'Supplier invoice no.', 'SINV-778', 'Supplier challan no.', 'DC-554', 'Mock Closet 1'), 'GRN print layout')
  await screenshot('grn-print')
  await goto('/goods-receipts')
  await waitFor(bodyHasAllCI('GRN-000001', 'Supplier invoice', 'Challan', 'Export to Excel'), 'GRN register columns')
  await fill('input[placeholder^="Search GRN"]', 'SINV-778')
  await waitFor(`${bodyHas('GRN-000001')} && !(${bodyHas('GRN-000009')})`, 'GRN search by supplier invoice')
  await goto('/purchase-orders')
  await waitFor(bodyHasAll('PO-000003', 'Export to Excel'), 'po list')
  await fill('input[placeholder^="Search PO"]', 'SDC-12')
  await waitFor(`${bodyHas('PO-000003')} && !(${bodyHas('PO-000002')})`, 'PO search by supplier challan')
})

await step('reorder planning: days of cover with available, reserved and incoming kept apart; lead time beside the recommendation', async () => {
  await goto('/inventory/alerts?tab=planning')
  await waitFor(bodyHasAllCI('Reorder planning (days of cover)', 'Reorder now', 'MOCK-CLAY', 'Days of cover', 'Lead time', 'Incoming', 'Reserved', 'Suggested order', '32.5'), 'planning view')
  assert(rpcCalls('inventory_reorder_plan').at(-1).body.p_history_days === 90, 'default history window')
  assert(await evaluate(bodyHasAll('No reorder level (days)', 'Enough cover')), 'statuses missing')
  await screenshot('reorder-planning')
  await click('button[role=tab], [role=tab], button', 'Stock alerts')
  await waitFor(bodyHas('Re-check now'), 'back to alerts')
})

// V2 Stage 2: unified ledger
await step('ledger: own sidebar section; combined, customer and supplier ledgers; a party shows its history', async () => {
  await goto('/ledger')
  await waitFor(bodyHasAll('Aqua Fittings LLP', 'Shree Clay', 'Acme Ltd'), 'parties')
  for (const text of ['Customer & Supplier Ledger', 'Customers', 'Suppliers', 'Customer & Supplier', 'Total Receivables', 'Total Payables', 'Export to Excel', 'Add party']) {
    assert(await evaluate(bodyHas(text)), `missing "${text}"`)
  }
  assert(rpcCalls('ledger_sync_parties').length > 0, 'parties were not synced before listing')
  // The Ledger section is separate from Billing & Invoicing and holds the four ledger pages.
  const ledgerLinks = await evaluate(`(() => { const b = [...document.querySelectorAll('aside nav button[aria-expanded]')].find((x) => x.innerText.trim().toLowerCase() === 'ledger'); return b ? [...document.getElementById(b.getAttribute('aria-controls')).querySelectorAll('a')].map((a) => a.getAttribute('href')) : null })()`)
  assert(JSON.stringify(ledgerLinks) === JSON.stringify(['/ledger/dashboard', '/ledger', '/ledger/customers', '/ledger/suppliers']), `ledger section: ${JSON.stringify(ledgerLinks)}`)
  const billingLinks = await evaluate(`(() => { const b = [...document.querySelectorAll('aside nav button[aria-expanded]')].find((x) => x.innerText.trim().toLowerCase() === 'billing & invoicing'); return [...document.getElementById(b.getAttribute('aria-controls')).querySelectorAll('a')].map((a) => a.getAttribute('href')) })()`)
  assert(!billingLinks.some((h) => h.startsWith('/ledger')), `billing still lists ledger pages: ${billingLinks.join(', ')}`)
  await screenshot('ledger-list')
  // Customer Ledger: customers and parties that are both; no payable column, no supplier-only parties.
  await goto('/ledger/customers')
  await waitFor(bodyHasAll('Customer Ledger', 'Acme Ltd', 'Total Receivables', 'Add customer'), 'customer ledger')
  assert(!(await evaluate(bodyHas('Total Payables'))), 'customer ledger shows payables')
  const supplierOnly = await evaluate(`[...document.querySelectorAll('td')].some((t) => t.innerText.trim() === 'Shree Clay')`)
  // Supplier Ledger: suppliers and parties that are both.
  await goto('/ledger/suppliers')
  await waitFor(bodyHasAll('Supplier Ledger', 'Shree Clay', 'Total Payables', 'Add supplier'), 'supplier ledger')
  assert(!(await evaluate(bodyHas('Total Receivables'))), 'supplier ledger shows receivables')
  assert(!(await evaluate(`[...document.querySelectorAll('td')].some((t) => t.innerText.trim() === 'Acme Ltd')`)), 'customer-only party in the supplier ledger')
  assert(!supplierOnly, 'supplier-only party in the customer ledger')
  await screenshot('ledger-suppliers')
  await click('td', 'Aqua Fittings LLP')
  await waitFor(`location.pathname === '/ledger/pty3'`, 'party page')
  await waitFor(bodyHasAll('Transaction history', 'Receivable (they owe us)', 'Payable (we owe them)', 'Net balance', 'GRN-000001', 'SPAY-000001', 'Record payment'), 'party detail')
  await screenshot('ledger-party')
})

await step('quick add: a new supplier from the purchase order screen, with a duplicate warning first', async () => {
  await goto('/purchase-orders/new')
  await waitFor(`!!document.querySelector('#po-supplier')`, 'po form')
  await click('[data-testid=po-add-supplier]', 'Add New Supplier')
  await waitFor(`!!document.querySelector('#qa-supplier-name')`, 'add supplier dialog')
  // The complete Ledger form (not a reduced one): every Ledger field is there.
  for (const f of ['name', 'legal', 'gstin', 'pan', 'phone', 'email', 'contact', 'state', 'city', 'bill', 'ship', 'pin', 'country', 'days', 'terms', 'cat', 'ob', 'obt', 'obd', 'bank', 'acname', 'acno', 'ifsc', 'remarks']) {
    assert(await evaluate(`!!document.querySelector('#qa-supplier-${f}')`), `field ${f} missing from the supplier form`)
  }
  // Party type: Supplier preselected; Customer & Supplier offered; Customer alone not (the PO needs a supplier).
  assert(await evaluate(`document.querySelector('#qa-supplier-type-supplier')?.getAttribute('aria-checked') === 'true' && !!document.querySelector('#qa-supplier-type-both') && !document.querySelector('#qa-supplier-type-customer')`), 'party type')
  assert(await evaluate(bodyHasAll('Recommendations', 'Bank details (optional)', 'Opening balance')), 'recommendations / sections')
  // Save and Cancel stay visible while the form scrolls.
  await evaluate(`document.querySelector('#party-form-dialog-form').scrollTop = 99999`)
  assert(await evaluate(`(() => { const b = document.querySelector('[data-testid=party-form-save]').getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight })()`), 'save button scrolled out of view')
  // Validation shown clearly: a bad GSTIN is refused before saving.
  await fill('#qa-supplier-gstin', '27BAD')
  await click('[data-testid=party-form-save]')
  await waitFor(`!!document.querySelector('[data-testid=party-form-errors]') && ${bodyHas('GSTIN must be 15 characters')}`, 'GSTIN error')
  assert(!rpcCalls('party_save').some((c) => c.body.p_party?.gstin === '27BAD'), 'an invalid GSTIN was sent')
  await fill('#qa-supplier-gstin', '27AABCM1234A1Z5')
  await fill('#qa-supplier-name', 'Shree Clay Works')
  await fill('#qa-supplier-ship', 'Plot 9, MIDC, Pune')
  await click('[role=dialog] button', 'Save supplier')
  await waitFor(bodyHas('This party may already exist'), 'duplicate warning')
  assert(!(rpcCalls('party_save').at(-1).body.p_confirm_duplicates), 'first save must not confirm duplicates')
  await click('[role=dialog] button', 'It is a different party')
  await waitFor(`!document.querySelector('#qa-supplier-name')`, 'dialog closed')
  const save = rpcCalls('party_save').at(-1).body
  assert(save.p_party_id === null && save.p_party.party_type === 'SUPPLIER' && save.p_party.party_name === 'Shree Clay Works' && save.p_confirm_duplicates === true, JSON.stringify(save))
  // GST and state: state and PAN are taken from the GSTIN, as in the Ledger.
  assert(save.p_party.gstin === '27AABCM1234A1Z5' && save.p_party.state_code === '27' && save.p_party.pan === 'AABCM1234A' && save.p_party.shipping_address === 'Plot 9, MIDC, Pune', JSON.stringify(save.p_party))
  await waitFor(`document.querySelector('[data-testid=po-party-note]')?.innerText.includes('selected as the supplier')`, 'success note')
  await sleep(800)
  await screenshot('quick-add-supplier')
  const shown = await evaluate(`document.querySelector('#po-supplier').innerText`)
  tables.suppliers = tables.suppliers.filter((s) => s.id !== 'sup-new')
  assert(String(shown).includes('SUP-000003'), `new supplier not selected; supplier box shows "${shown}"; option requests: ${rpcCalls('purchase_supplier_options').length}`)
})
await step('Add New Customer from a sales order: the complete Ledger form; saved, selected and its addresses and GSTIN filled in without a reload; the order entered so far is kept', async () => {
  const before = { customers: tables.customers.length }
  const v = (sel) => `document.querySelector(${JSON.stringify(sel)})?.value`
  try {
    await goto('/sales/orders/new')
    await waitFor(`!!document.querySelector('#so-customer') && !!document.querySelector('[data-testid=so-add-customer]')`, 'sales order form')
    await fill('#so-ref', 'PO-ACME-77')
    await click('[data-testid=so-add-customer]', 'Add New Customer')
    await waitFor(`!!document.querySelector('#qa-customer-name')`, 'add customer dialog')
    for (const f of ['legal', 'pan', 'ship', 'pin', 'country', 'terms', 'ob', 'obt', 'obd', 'bank', 'acname', 'acno', 'ifsc', 'remarks']) {
      assert(await evaluate(`!!document.querySelector('#qa-customer-${f}')`), `field ${f} missing from the customer form`)
    }
    assert(await evaluate(`document.querySelector('#qa-customer-type-customer')?.getAttribute('aria-checked') === 'true' && !!document.querySelector('#qa-customer-type-both') && !document.querySelector('#qa-customer-type-supplier')`), 'party type')
    assert(!(await evaluate(`!!document.querySelector('#qa-customer-cat')`)), 'supplier category shown for a customer')
    await screenshot('197-add-customer-from-sales-order')
    await fill('#qa-customer-name', 'Nova Bath Studio')
    await fill('#qa-customer-gstin', '29AAGCN5555K1Z3')
    await fill('#qa-customer-bill', '12 MG Road, Bengaluru')
    await fill('#qa-customer-ship', 'Warehouse 4, Hosur Road, Bengaluru')
    await fill('#qa-customer-days', '30')
    await click('[data-testid=party-form-save]')
    await waitFor(`!document.querySelector('#qa-customer-name')`, 'dialog closed')
    const save = rpcCalls('party_save').at(-1).body
    assert(save.p_party.party_type === 'CUSTOMER' && save.p_party.state_code === '29' && save.p_party.pan === 'AAGCN5555K', JSON.stringify(save.p_party))
    await waitFor(`document.querySelector('#so-customer')?.innerText.includes('CUS-000009')`, 'new customer selected')
    await waitFor(`${v('#so-bill')} === '12 MG Road, Bengaluru' && ${v('#so-ship')} === 'Warehouse 4, Hosur Road, Bengaluru' && ${v('#so-gstin')} === '29AAGCN5555K1Z3'`, 'addresses and GSTIN filled')
    assert(await evaluate(`${v('#so-ref')} === 'PO-ACME-77'`), 'the order entered so far was lost')
    assert(await evaluate(`document.querySelector('[data-testid=so-party-note]')?.innerText.includes('saved in the Ledger and selected')`), 'success note')
    assert(tables.customers.length === before.customers + 1, 'customer not created once')
  } finally {
    tables.customers = tables.customers.filter((c) => c.id !== 'cu-new')
  }
})

// V2 Stage 3: goods received notes (bulk PO upload is not offered)
await step('GRN register: receipts against orders and unlinked receipts, with KPIs; no PO import button', async () => {
  await goto('/purchase-orders')
  await waitFor(bodyHas('PO-000003'), 'po list')
  assert(!(await evaluate(bodyHas('Import from Excel'))), 'bulk PO import still offered')
  await click('a', 'Goods received')
  await waitFor(`location.pathname === '/goods-receipts'`, 'grn register')
  await waitFor(bodyHasAll('GRN-000001', 'GRN-000009', 'PO-000003', 'Unlinked GRNs', 'Receive without PO', 'Receive against PO'), 'register')
  await click('[role=tab], button', 'Unlinked')
  await waitFor(`${bodyHas('GRN-000009')} && !(${bodyHas('GRN-000001')})`, 'unlinked filter')
  await screenshot('grn-register')
})

await step('GRN: receive without a PO shows the unlinked warning, validates and posts once', async () => {
  const sentBefore = poCalls('goods_receipt_direct_post_refs').length
  await goto('/goods-receipts')
  await waitFor(bodyHas('Receive without PO'), 'register')
  await click('button', 'Receive without PO')
  await waitFor(`!!document.querySelector('#dr-prod-0')`, 'direct receipt dialog')
  assert(await evaluate(bodyHas('This is an unlinked receipt')), 'unlinked warning missing')
  await click('[role=dialog] button[type=submit]')
  await waitFor(bodyHas('Add at least one product received.'), 'validation')
  assert(poCalls('goods_receipt_direct_post_refs').length === sentBefore, 'invalid receipt sent')
  await fill('#dr-prod-0', 'MOCK-WC-1')
  await press('#dr-prod-0')
  await waitFor(bodyHas('Mock Closet 1'), 'product chosen')
  await fill('input[id^="dr-rec-"]', '3')
  await fill('#dr-invoice', 'LOCAL-77')
  await screenshot('grn-direct-dialog')
  await click('[role=dialog] button[type=submit]')
  await waitFor(`location.pathname === '/goods-receipts/gr9'`, 'went to the new GRN')
  await waitFor(bodyHasAll('GRN-000009 posted without a purchase order', 'No supplier was recorded', 'Unlinked receipt', 'TXN-000095'), 'posted notice and detail')
  const c = poCalls('goods_receipt_direct_post_refs').at(-1)
  assert(c.p_header.warehouse_id === 'w1' && c.p_header.supplier_id === null && /^[0-9a-f-]{36}$/.test(c.p_idempotency_key), 'wrong header ' + JSON.stringify(c.p_header))
  assert(c.p_header.supplier_invoice_number === 'LOCAL-77' && c.p_header.supplier_challan_number === null, 'direct GRN references ' + JSON.stringify(c.p_header))
  const l = c.p_lines[0]
  assert(c.p_lines.length === 1 && l.product_id === 'p1' && l.received_quantity === '3' && l.accepted_quantity === '3' && l.rejected_quantity === '0' && l.accepted_location_id,
    'wrong lines ' + JSON.stringify(c.p_lines))
})

await step('GRN: a receipt against a PO is corrected (reversed and re-posted) with a reason', async () => {
  await goto('/goods-receipts/gr1')
  await waitFor(bodyHasAll('GRN-000001', 'Items received', 'PO-000003', 'Correct', 'Reverse', 'Attachments'), 'grn detail')
  assert(await evaluate(bodyHasAllCI('PO price', 'Actual cost', 'Difference', 'Not recorded', 'Payable (incl. GST)', 'From PO line')), 'GRN detail price columns')
  await click('button', 'Correct')
  await waitFor(`!!document.querySelector('#gr-correction') && document.querySelector('#gr-pol3a-rec').value === '2'`, 'correction dialog prefilled')
  assert(await evaluate(`document.querySelector('#gr-invoice').value === 'SINV-778' && document.querySelector('#gr-challan').value === 'DC-554'`), 'correction does not carry the GRN references')
  await fill('#gr-pol3a-rec', '3')
  await click('[role=dialog] button[type=submit]')
  await waitFor(`[...document.querySelectorAll('[role=dialog] [role=alert]')].length > 0`, 'reason required')
  assert(poCalls('goods_receipt_correct_refs').length === 0, 'corrected without a reason')
  await fill('#gr-correction', 'Recounted at the gate')
  await click('[role=dialog] button[type=submit]')
  await waitFor(bodyHas('GRN-000001 reversed and corrected as GRN-000010'), 'corrected notice')
  const c = poCalls('goods_receipt_correct_refs').at(-1)
  assert(c.p_receipt_id === 'gr1' && c.p_reason === 'Recounted at the gate' && c.p_lines[0].po_line_id === 'pol3a' && c.p_lines[0].received_quantity === '3',
    'wrong correction ' + JSON.stringify(c))
  assert(c.p_header.supplier_invoice_number === 'SINV-778' && c.p_header.supplier_challan_number === 'DC-554', 'corrected receipt loses its references')
  await screenshot('grn-detail')
})

await step('purchase orders: GRN links, delivery date change without a new revision, attachments, duplicate and ?receive=1', async () => {
  await goto('/purchase-orders/po3')
  await waitFor(bodyHasAll('PO-000003', 'Delivery date / notes', 'Edit order (new revision)', 'Duplicate', 'Attachments'), 'po actions')
  assert(await evaluate(`!!document.querySelector('a[href="/goods-receipts/gr1"]')`), 'receipt does not link to its GRN')
  assert(!(await evaluate(bodyHas('File attachments are not available'))), 'old attachments notice shown')
  await click('button', 'Delivery date / notes')
  await waitFor(`!!document.querySelector('#pd-date')`, 'details dialog')
  await fill('#pd-date', '2026-12-15')
  await click('[role=dialog] button', 'Save')
  await waitFor(bodyHas('PO-000003: delivery date and notes saved.'), 'saved')
  const u = poCalls('purchase_order_update_details').at(-1)
  assert(u.p_po_id === 'po3' && u.p_changes.expected_delivery_date === '2026-12-15' && !('quantity' in u.p_changes), 'wrong details update ' + JSON.stringify(u))
  await click('a', 'Duplicate')
  await waitFor(`location.pathname === '/purchase-orders/new' && location.search === '?copy=po3'`, 'duplicate form')
  await waitFor(bodyHas('Copied from PO-000003'), 'copy notice')
  const saves = poCalls('purchase_order_save_refs').length
  await click('button[type=submit]', 'Save draft')
  await waitFor(`location.pathname === '/purchase-orders/po1'`, 'saved copy')
  const s = poCalls('purchase_order_save_refs').at(-1)
  assert(poCalls('purchase_order_save_refs').length === saves + 1 && s.p_po_id === null && s.p_header.supplier_id === 'sup1' && s.p_lines.length === 2
    && s.p_lines.every((l) => !l.id) && s.p_lines[0].product_id === 'p1', 'wrong duplicate ' + JSON.stringify(s))
  await goto('/purchase-orders/po3?receive=1')
  await waitFor(`!!document.querySelector('#gr-pol3a-rec')`, 'receive dialog opened from the link')
})

const resetCalls = () => requests.filter((r) => r.path === '/functions/v1/reset-erp-data')
const signOut = async () => {
  await click('button[aria-label="Account menu"]')
  await click('[role=menuitem]', 'Sign out')
  await waitFor(`location.pathname === '/login'`, 'signed out')
}

// ---------------------------------------------------------------------------
// Immutable product / component / BOM versions (20261118090000) — numbers refer to section 11 of the request
// ---------------------------------------------------------------------------
const productPatches = () => requests.filter((r) => r.method === 'PATCH' && r.path === '/rest/v1/products')
await step('Versions 1/10: editing a product needs a reason, which is sent with the change (the new version records it)', async () => {
  await goto('/products/p1/edit')
  await waitFor(`!!document.querySelector('#p-change-reason') && !!document.querySelector('#p-product_name')`, 'edit form with the reason field')
  await waitFor(`document.querySelector('[data-draft-status]')?.dataset.draftStatus !== 'loading'`, 'draft check')
  await fill('#p-product_name', 'Mock Closet 1 Premium')
  const before = productPatches().length
  await click('button[type=submit]', 'Save changes')
  await waitFor(bodyHas('Enter the reason for this change'), 'reason required')
  assert(productPatches().length === before, 'saved without a reason')
  await fill('#p-change-reason', 'New glaze from the supplier')
  await click('button[type=submit]', 'Save changes')
  await waitFor(`location.pathname === '/products/p1'`, 'saved')
  const body = productPatches().at(-1).body
  assert(body.product_name === 'Mock Closet 1 Premium' && body.change_reason === 'New glaze from the supplier', JSON.stringify(body))
  await waitFor(`!!document.querySelector('main a[href="/products/p1/versions"]')`, 'version history link')
})

await step('Versions: product history (who, when, reason, previous -> new value) and a comparison of two versions', async () => {
  await click('main a[href="/products/p1/versions"]')
  await waitFor(bodyHasAll('Revision history — MOCK-WC-1', 'v1 (legacy baseline)', 'New glaze from the supplier', 'Mock Closet 1 → Mock Closet 1 Premium', 'Current', 'Superseded'), 'history')
  await waitFor(`document.querySelector('tr[data-field=product_name]') && document.querySelector('tr[data-field=standard_cost]')`, 'comparison')
  assert(await evaluate(`!document.querySelector('tr[data-field=hsn_code]')`), 'unchanged fields shown with "Only changed fields"')
  assert(await evaluate(bodyHasAll('Previous values (v1 (legacy baseline))', 'Current values (v2)')), 'previous / current headings missing')
  await click('#cmp-only')
  await waitFor(`!!document.querySelector('tr[data-field=hsn_code]')`, 'all fields')
  await click('button[aria-label="View version 1"]')
  await waitFor(`document.querySelector('[data-testid=version-view]')?.innerText.includes('v1 (legacy baseline) — read-only') && document.querySelector('[data-testid=version-view]').innerText.includes('Mock Closet 1')`, 'read-only version view')
  assert(await evaluate(`!document.querySelector('[data-testid=version-view] input, [data-testid=version-view] textarea')`), 'historical version is editable')
  await screenshot('113-product-versions')
})

await step('Versions 3: BOM versions with lifecycle, reason, approver and the component differences', async () => {
  await goto('/production/boms/bom2/versions')
  await waitFor(bodyHasAll('BOM versions — MOCK-WC-1', 'Active', 'Superseded', 'Three-bowl design', 'First release'), 'BOM versions')
  const row = (sku, change) => `document.querySelector('tr[data-component="${sku}"][data-change=${change}]')`
  await waitFor(`${row('MOCK-PLUG', 'ADDED')} && ${row('MOCK-OLD', 'REMOVED')} && ${row('MOCK-A1', 'CHANGED')} && ${row('MOCK-B1', 'UNCHANGED')}`, 'component differences')
  assert(await evaluate(`${row('MOCK-A1', 'CHANGED')}.innerText.includes('quantity, component version, cost') && ${row('MOCK-A1', 'CHANGED')}.innerText.includes('v1 → v2')
    && ${row('MOCK-A1', 'CHANGED')}.innerText.includes('Modified') && ${row('MOCK-A1', 'CHANGED')}.innerText.includes('₹36.00 (+26.00)')`), 'change details missing')
  await waitFor(`${bodyHasAll('Added: 1', 'Removed: 1', 'Modified: 1', 'by v2')} && document.querySelector('tr[data-field=unit_cost]')?.innerText.includes('₹32.00') && document.querySelector('tr[data-field=unit_cost]').innerText.includes('₹59.00')`, 'costs and indicators')
  await screenshot('114-bom-versions')
})

await step('Activation: the active BOM is edited directly; saving needs a reason and creates and activates the next version (no approval step)', async () => {
  await goto('/production/boms/bom1')
  await waitFor(`!!document.querySelector('[data-testid=bom-revise-note]') && !!document.querySelector('#bom-change-reason') && !document.querySelector('#bom-change-reason').disabled`, 'active version editable for an authorised user')
  assert(!(await evaluate(`[...document.querySelectorAll('button')].some((b) => /Submit for approval/.test(b.innerText))`)), 'an approval step is offered')
  const calls = () => rpcCalls('production_bom_save_and_activate')
  // An earlier visit may have auto-saved a draft of this form (restored with its reason); start without a reason.
  await waitFor("!document.querySelector('[data-draft-status]') || document.querySelector('[data-draft-status]').dataset.draftStatus !== 'loading'", 'draft check')
  await sleep(300)
  await fill('#bom-change-reason', '')
  const before = calls().length
  await click('button', 'Save as new version (activates now)')
  try {
    await waitFor(bodyHas('Enter the reason for this change'), 'reason required')
  } catch (e) {
    throw new Error(e.message + ' — page says: ' + (await evaluate("[...document.querySelectorAll('[role=alert],[role=status]')].map((x) => x.innerText).join(' | ') + ' reason=' + JSON.stringify(document.querySelector('#bom-change-reason')?.value)")))
  }
  assert(calls().length === before, 'saved without a reason')
  await fill('#bom-change-reason', 'Three-bowl design')
  await click('button', 'Save as new version (activates now)')
  await waitFor(`location.pathname === '/production/boms/bom2' && ${bodyHas('saved and activated: new production orders use it now')} && ${bodyHas('Superseded: v1')}`, 'activated')
  const body = calls().at(-1).body
  assert(body.p_bom_id === 'bom1' && body.p_change_reason === 'Three-bowl design' && /^[0-9a-f-]{36}$/.test(body.p_idempotency_key), JSON.stringify(body))
  assert(rpcCalls('production_bom_action').length === 0 || !rpcCalls('production_bom_action').some((r) => r.body.p_action === 'SUBMIT'), 'submitted for approval')
  await screenshot('115-bom-activated')
})

await step('Draft rule: an edited production order keeps its BOM and component versions unless the user chooses the latest', async () => {
  const saves = () => rpcCalls('production_order_v2_save')
  await goto('/production/orders/po1/edit')
  await waitFor(`document.querySelector('[data-testid=draft-version-notice]') && ${bodyHasAll('Newer versions are available', 'BOM version: BOM-000001 v1 → BOM-000001 v2', 'Component version')}`, 'notice')
  await screenshot('116-draft-version-notice')
  let before = saves().length
  await click('button', 'Save and recalculate')
  await waitFor(`location.pathname === '/production/orders/po1'`, 'saved (kept)')
  assert(saves().length === before + 1, 'not saved')
  assert(!('use_latest_versions' in saves().at(-1).body.p_data), 'switched to the latest without being asked')
  await goto('/production/orders/po1/edit')
  await waitFor(`!!document.querySelector('[data-testid=draft-version-notice]')`, 'notice again')
  await click('[data-testid=draft-version-notice] button', 'Refresh to the latest versions')
  await waitFor(`document.querySelector('[data-testid=draft-version-notice]')?.dataset.choice === 'latest'`, 'latest chosen')
  await click('[data-testid=draft-version-notice] button', 'Keep the current versions instead')
  await waitFor(`document.querySelector('[data-testid=draft-version-notice]') && document.querySelector('[data-testid=draft-version-notice]').dataset.choice !== 'latest'`, 'undone')
  await click('[data-testid=draft-version-notice] button', 'Refresh to the latest versions')
  before = saves().length
  await click('button', 'Save and recalculate')
  await waitFor(`location.pathname === '/production/orders/po1'`, 'saved (latest)')
  assert(saves().length === before + 1 && saves().at(-1).body.p_data.use_latest_versions === true, JSON.stringify(saves().at(-1).body))
})

await step('Draft rule: a draft purchase order shows newer product versions; it changes only when the user refreshes it', async () => {
  draftRefreshed.clear()
  await goto('/purchase-orders/po1/edit')
  await waitFor(`document.querySelector('[data-testid=draft-version-notice]') && ${bodyHasAll('Description: Mock Closet 1 → Mock Closet 1 Premium', 'GST rate: 12 → 18', 'a commercial term')}`, 'notice')
  await click('[data-testid=draft-version-notice] button', "Keep the draft's versions")
  await waitFor(`!document.querySelector('[data-testid=draft-version-notice]')`, 'kept')
  assert(rpcCalls('draft_refresh_versions').length === 0, 'refreshed without being asked')
  await goto('/purchase-orders/po1/edit')
  await waitFor(`!!document.querySelector('[data-testid=draft-version-notice]')`, 'notice again')
  await click('[data-testid=draft-version-notice] button', 'Refresh to the latest versions')
  await waitFor(`!document.querySelector('[data-testid=draft-version-notice]') && !!document.querySelector('#po-ref')`, 'refreshed and reloaded')
  const call = rpcCalls('draft_refresh_versions').at(-1)?.body
  assert(call?.p_kind === 'PURCHASE_ORDER' && call.p_id === 'po1', JSON.stringify(call))
})

await step('Versions 8/9: the stock movement report shows the version at the time, and the Excel export carries the same values', async () => {
  await goto('/reports/view/stock_movements')
  await waitFor(`${bodyHasAll('Mock Closet 1 Premium', 'Legacy / Unversioned')} && document.querySelector('table th') && [...document.querySelectorAll('table th')].some((th) => th.innerText.trim().toLowerCase() === 'version')`, 'report with versions')
  const before = new Set(readdirSync(downloadDir))
  await click('button', 'Excel')
  let file = null
  for (let i = 0; i < 50 && !file; i++) {
    await sleep(200)
    file = readdirSync(downloadDir).find((n) => !before.has(n) && /stock-movements.*\.xlsx$/.test(n)) ?? null
  }
  assert(file, 'no Excel file downloaded')
  await sleep(300)
  const XLSX = await import('xlsx')
  const wb = XLSX.read(readFileSync(path.join(downloadDir, file)))
  const sheet = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })
  const head = sheet.findIndex((r) => r.includes('Version'))
  assert(head >= 0, 'no version column in the export')
  const vi = sheet[head].indexOf('Version')
  const ni = sheet[head].indexOf('Product')
  const got = sheet.slice(head + 1).map((r) => [r[ni], r[vi]])
  assert(JSON.stringify(got) === JSON.stringify([['Mock Closet 1', 'v1'], ['Mock Closet 1 Premium', 'v2'], ['Old washer', 'Legacy / Unversioned']]), JSON.stringify(got))
})

// ---------------------------------------------------------------------------
// Persistent form drafts (auto-save) — numbers refer to section 11 of the request
// ---------------------------------------------------------------------------
const draftStatusIs = (s) => `document.querySelector('[data-draft-status]')?.dataset.draftStatus === ${JSON.stringify(s)}`
const val = (sel) => `document.querySelector(${JSON.stringify(sel)})?.value`
const draftSaves = (form) => rpcCalls('erp_form_draft_save').filter((r) => r.body.p_form_key === form)
const draftCloses = (form) => rpcCalls('erp_form_draft_close').filter((r) => r.body.p_form_key === form)
const PO_QTY = '[id^="ln-"][id$="-qty"]'
async function openNewPo() {
  await goto('/purchase-orders/new')
  await waitFor(`!!document.querySelector('#po-ref') && document.querySelector('[data-draft-status]')?.dataset.draftStatus !== 'loading'`, 'po form ready')
}

await step('Drafts 1/2/8: entries on a new purchase order (header and line items) survive switching modules and come back with the restore notice', async () => {
  // Earlier steps used this form too: start from no draft at all.
  formDrafts.clear()
  await evaluate(`Object.keys(localStorage).filter((k) => k.startsWith('alton:draft:')).forEach((k) => localStorage.removeItem(k))`)
  await openNewPo()
  assert(!(await evaluate(bodyHas('An unsaved draft was found'))), 'notice without a draft')
  await fill('#po-ref', 'DRAFT-REF-17')
  await fill('#po-notes', 'Keep this note')
  await fill(PO_QTY, '7')
  await waitFor(draftStatusIs('saved'), 'auto-saved after the pause', 8000)
  const saved = draftSaves('purchase.order').at(-1).body
  assert(saved.p_data.h.reference_number === 'DRAFT-REF-17' && saved.p_data.lines[0].quantity === '7' && !('key' in saved.p_data.lines[0])
    && saved.p_record_id === null && saved.p_scope === '' && saved.p_expected_version === 0, JSON.stringify(saved))
  assert(!JSON.stringify(saved).includes(COMPANY_ID) && !('p_company_id' in saved) && !('p_user_id' in saved), 'company or user sent by the browser')
  assert(await evaluate(bodyHas('All changes saved')), 'status text missing')
  await screenshot('109-draft-saved')
  await goto('/inventory')
  await waitFor(bodyHas('Inventory'), 'inventory')
  await openNewPo()
  await waitFor(`${bodyHas('An unsaved draft was found. Your previous entries have been restored.')} && ${val('#po-ref')} === 'DRAFT-REF-17'`, 'restored')
  assert(await evaluate(`${val('#po-notes')} === 'Keep this note' && ${val(PO_QTY)} === '7'`), 'notes or line quantity not restored')
  await screenshot('110-draft-restored')
})

await step('Drafts: leaving through the menu saves at once (no waiting for the pause); a full page change keeps a browser copy', async () => {
  await fill('#po-ref', 'LEFT-QUICKLY')
  const before = draftSaves('purchase.order').length
  await click('aside a[href="/inventory"]')
  await waitFor(`location.pathname === '/inventory'`, 'menu navigation')
  await waitFor(`true`, 'tick')
  const start = Date.now()
  while (draftSaves('purchase.order').length === before && Date.now() - start < 3000) await sleep(100)
  assert(draftSaves('purchase.order').at(-1)?.body.p_data.h.reference_number === 'LEFT-QUICKLY', 'pending change not saved when leaving the form')
  await openNewPo()
  await waitFor(`${val('#po-ref')} === 'LEFT-QUICKLY'`, 'restored after menu navigation')
  await fill('#po-ref', 'FULL-RELOAD')
  await goto('/products')
  await openNewPo()
  await waitFor(`${val('#po-ref')} === 'FULL-RELOAD'`, 'restored after a full page change (browser copy, then saved)')
})

await step('Drafts 3/12: refresh, browser back and forward restore the entries', async () => {
  await waitFor(draftStatusIs('saved'), 'saved', 8000)
  await cdp('Page.reload')
  await sleep(300)
  await waitFor(`location.pathname === '/purchase-orders/new' && ${val('#po-ref')} === 'FULL-RELOAD' && ${val(PO_QTY)} === '7'`, 'restored after refresh')
  await goto('/products')
  await waitFor(`location.pathname === '/products'`, 'products')
  await evaluate('history.back()')
  await waitFor(`location.pathname === '/purchase-orders/new' && ${val('#po-ref')} === 'FULL-RELOAD'`, 'restored after Back')
  await evaluate('history.forward()')
  await waitFor(`location.pathname === '/products'`, 'forward')
  await evaluate('history.back()')
  await waitFor(`location.pathname === '/purchase-orders/new' && ${val('#po-ref')} === 'FULL-RELOAD'`, 'restored after Back again')
})

await step('Drafts 11: a change saved from another window is never overwritten; the user chooses', async () => {
  await waitFor(`location.pathname === '/purchase-orders/new' && document.querySelector('[data-draft-status]')?.dataset.draftStatus !== 'loading'`, 'form ready')
  const k = `${USERS['manager@test.invalid'].id}|purchase.order||`
  const row = formDrafts.get(k)
  formDrafts.set(k, { ...row, version: row.version + 1, data: { ...row.data, h: { ...row.data.h, reference_number: 'OTHER-WINDOW' } } })
  await fill('#po-ref', 'THIS-WINDOW')
  await waitFor(`document.querySelector('[data-draft-notice=conflict]')`, 'conflict notice', 8000)
  assert(formDrafts.get(k).data.h.reference_number === 'OTHER-WINDOW', 'the other window\'s draft was overwritten')
  assert(await evaluate(`${draftStatusIs('conflict')} && ${val('#po-ref')} === 'THIS-WINDOW'`), 'entries changed before the user chose')
  await screenshot('111-draft-conflict')
  await click('[data-draft-notice=conflict] button', 'Load the other version')
  await waitFor(`${val('#po-ref')} === 'OTHER-WINDOW' && !document.querySelector('[data-draft-notice=conflict]')`, 'other version loaded')
  await fill('#po-ref', 'AFTER-CONFLICT')
  await waitFor(draftStatusIs('saved'), 'saving works again', 8000)
  assert(formDrafts.get(k).data.h.reference_number === 'AFTER-CONFLICT', 'not saved after resolving')
})

await step('Drafts: a failed save shows "Unable to save — Retry", keeps the entries, and Retry saves them', async () => {
  draftFailures = 1
  await fill('#po-ref', 'OFFLINE-EDIT')
  await waitFor(`${draftStatusIs('error')} && ${bodyHas('Unable to save')}`, 'save failed shown', 8000)
  assert(await evaluate(`${val('#po-ref')} === 'OFFLINE-EDIT'`), 'entries lost after a failed save')
  await screenshot('112-draft-save-failed')
  await click('[data-testid=form-draft-bar] button', 'Retry')
  await waitFor(draftStatusIs('saved'), 'saved after Retry', 8000)
  assert(formDrafts.get(`${USERS['manager@test.invalid'].id}|purchase.order||`).data.h.reference_number === 'OFFLINE-EDIT', 'retry did not save')
})

await step('Drafts: Discard Draft resets the form and closes the draft; Restore Draft brings it back', async () => {
  await click('[data-testid=form-draft-bar] button', 'Discard Draft')
  await waitFor(`${val('#po-ref')} === '' && ${bodyHas('Draft discarded.')}`, 'discarded')
  assert(draftCloses('purchase.order').at(-1).body.p_status === 'discarded', 'draft not closed as discarded')
  await click('[data-draft-notice=discarded] button', 'Restore Draft')
  await waitFor(`${val('#po-ref')} === 'OFFLINE-EDIT'`, 'restored')
  await waitFor(draftStatusIs('saved'), 'saved again', 8000)
})

await step('Drafts 5/6: signing out and in again restores the same user\'s draft; another user never sees it', async () => {
  await signOut()
  assert(await evaluate(`!Object.keys(localStorage).some((k) => k.startsWith('alton:draft:v1:${USERS['manager@test.invalid'].id}:') && !JSON.parse(localStorage.getItem(k)).dirty)`), 'synced browser copies kept after sign-out')
  await login('owner@test.invalid')
  await waitFor(`location.pathname !== '/login'`, 'owner signed in')
  await openNewPo()
  assert(await evaluate(`${val('#po-ref')} === '' && !(${bodyHas('An unsaved draft was found')})`), 'another user saw the draft')
  await signOut()
  await login('manager@test.invalid')
  await waitFor(`location.pathname !== '/login'`, 'manager signed in')
  await openNewPo()
  await waitFor(`${val('#po-ref')} === 'OFFLINE-EDIT' && ${bodyHas('An unsaved draft was found')}`, 'restored after signing in again')
})

await step('Drafts 10: a failed submission keeps the draft; a successful one closes it', async () => {
  await goto('/ledger/new?type=CUSTOMER')
  await waitFor(`!!document.querySelector('#pt-name') && document.querySelector('[data-draft-status]')?.dataset.draftStatus !== 'loading'`, 'party form')
  await fill('#pt-name', 'Draft Customer Pvt Ltd')
  await waitFor(draftStatusIs('saved'), 'party draft saved', 8000)
  failNext.add('party_save')
  await click('button[type=submit]', 'Save party')
  await waitFor(`!!document.querySelector('[role=alert]')`, 'submission error')
  assert(draftCloses('ledger.party').length === 0, 'draft closed after a failed submission')
  await goto('/inventory')
  await goto('/ledger/new?type=CUSTOMER')
  await waitFor(`${val('#pt-name')} === 'Draft Customer Pvt Ltd'`, 'draft kept after the failure')
  await click('button[type=submit]', 'Save party')
  await waitFor(`location.pathname === '/ledger/pty-new'`, 'saved')
  const close = draftCloses('ledger.party').at(-1)?.body
  assert(close?.p_status === 'submitted' && close.p_scope === 'CUSTOMER', JSON.stringify(close))
  await goto('/ledger/new?type=CUSTOMER')
  await waitFor(`!!document.querySelector('#pt-name') && document.querySelector('[data-draft-status]')?.dataset.draftStatus !== 'loading'`, 'party form again')
  assert(await evaluate(`${val('#pt-name')} === '' && !(${bodyHas('An unsaved draft was found')})`), 'submitted draft came back')
  formDrafts.clear()
  await evaluate(`Object.keys(localStorage).filter((k) => k.startsWith('alton:draft:')).forEach((k) => localStorage.removeItem(k))`)
})

await step('ERP reset: hidden from an administrator who is not a Super Admin', async () => {
  const previews = rpcCalls('erp_reset_preview').length
  await goto('/admin/erp-settings?tab=system')
  await waitFor(bodyHas('Security & audit'), 'ERP settings')
  assert(!(await evaluate(bodyHas('Reset ERP Data'))), 'reset card shown to a non-Super Admin')
  assert(!(await evaluate(bodyHas('Force Reset / Delete Everything'))), 'force reset shown to a non-Super Admin')
  assert(rpcCalls('erp_reset_preview').length === previews, 'preview requested for a non-Super Admin')
})

await step('ERP reset: Super Admin sees the warning, impact summary, kept data and backup advice', async () => {
  await signOut()
  await login('owner@test.invalid')
  await waitFor(`location.pathname !== '/login'`, 'owner signed in')
  await goto('/admin/erp-settings?tab=system')
  await waitFor(bodyHasAll('Reset ERP Data', 'Permanently deletes business and operational data', 'Will be deleted (7 records)', 'Customers & suppliers: 5', 'Kept'), 'reset card')
  assert(await evaluate(bodyHas('verified database backup')), 'backup recommendation missing')
  assert(await evaluate(bodyHas('Your Super Admin account')), 'kept summary missing')
  await screenshot('98-erp-reset-card')
})

await step('ERP reset: modal requires password and RESET ERP; wrong password shows the error, no success', async () => {
  await goto('/admin/erp-settings?tab=system')
  await waitFor(`location.pathname === '/admin/erp-settings' && ${bodyHas('Will be deleted (7 records)')}`, 'reset card')
  // Let the other settings sections finish loading: the click is by position and the card moves while they do.
  await sleep(800)
  await click('button', 'Reset ERP Data')
  // The confirmation label is a flex row, so its words are separate lines in innerText.
  await waitFor(`${bodyHasAll('Permanently Reset ERP Data?', 'Your password')} && document.querySelector('label[for=reset-confirm]').textContent === 'Type RESET ERP to confirm'
    && document.querySelector('#reset-password').type === 'password'`, 'modal')
  const finalDisabled = () => evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.includes('Permanently Reset ERP')).disabled`)
  assert(await finalDisabled(), 'final button enabled with empty fields')
  await fill('#reset-password', 'correct-horse')
  await fill('#reset-confirm', 'reset erp')
  assert(await finalDisabled(), 'final button enabled with the wrong confirmation text')
  await fill('#reset-password', 'wrong-password')
  await fill('#reset-confirm', 'RESET ERP')
  assert(!(await finalDisabled()), 'final button disabled with both fields filled')
  const before = resetCalls().length
  await click('[role=dialog] button', 'Permanently Reset ERP')
  await waitFor(bodyHas('The password is incorrect. Nothing was deleted.'), 'wrong password error')
  assert(resetCalls().length === before + 1, 'reset request not sent')
  assert(!(await evaluate(bodyHas('reset completed successfully'))), 'success shown after a failure')
  assert(await evaluate(`document.querySelector('#reset-password').value === ''`), 'password kept in the form after the request')
  await screenshot('99-erp-reset-wrong-password')
})

await step('ERP reset: correct password resets on the server; success shown only after verification, then the ERP reloads', async () => {
  await fill('#reset-password', 'correct-horse')
  await click('[role=dialog] button', 'Permanently Reset ERP')
  await waitFor(bodyHas('ERP data reset completed successfully. Eligible business data was deleted from Supabase. Your super admin account and system configuration have been preserved.'), 'success message')
  const call = resetCalls().at(-1)
  assert(call.body.confirmation === 'RESET ERP' && /^[0-9a-f-]{36}$/.test(call.body.request_id), 'confirmation or request id missing')
  assert(!('user_id' in call.body) && !('company_id' in call.body), 'the browser sent a user or company id')
  await screenshot('100-erp-reset-done')
  const previews = rpcCalls('erp_reset_preview').length
  await evaluate('window.__beforeReload = true')
  await click('[role=dialog] button', 'Reload the ERP')
  await waitFor(`!window.__beforeReload && location.pathname === '/admin/erp-settings' && ${bodyHas('Will be deleted')}`, 'reloaded')
  assert(rpcCalls('erp_reset_preview').length > previews, 'data not reloaded from the server after the reset')
})

const forceCalls = () => rpcCalls('erp_force_reset_now')
const forceButtonDisabled = () => evaluate(`[...document.querySelectorAll('[data-testid=force-reset-section] button')].find((b) => b.innerText.includes('Force Reset / Delete Everything')).disabled`)

await step('Force reset: the red button is clickable straight away (no approval, backup or password); preview lists scope and kept data', async () => {
  await goto('/admin/erp-settings?tab=system')
  await waitFor(bodyHasAll('Force Reset / Delete Everything', 'Preview Force Reset', 'View Reset History', 'Test Co', COMPANY_ID), 'force section')
  for (const gone of ['Verify Backup', 'approved as demo']) assert(!(await evaluate(bodyHas(gone))), `still shown: ${gone}`)
  assert(!(await forceButtonDisabled()), 'force reset button disabled')
  assert(rpcCalls('erp_force_reset_preview').length === 0, 'the force preview ran before the user asked for it')
  await click('[data-testid=force-reset-section] button', 'Preview Force Reset')
  await waitFor(bodyHasAll('Records to delete', '51', 'Protected records', '43', 'Stored files to remove',
    'Protected records the standard reset cannot delete', 'Stock ledger (40)', 'Company-level documents and their files'), 'force preview')
  assert(rpcCalls('erp_force_reset_preview').at(-1).body.p_company_id === COMPANY_ID, 'preview not scoped to the selected company')
  assert(!(await evaluate(`Boolean(document.querySelector('[data-gate=environment], [data-gate=backup]'))`)), 'approval / backup gates still listed')
  assert(!(await forceButtonDisabled()), 'force reset disabled after the preview')
  await screenshot('101-force-reset-preview')
})

await step('Force reset: one click opens a single confirmation; Cancel deletes nothing', async () => {
  await click('[data-testid=force-reset-section] button', 'Force Reset / Delete Everything')
  await waitFor(bodyHasAll('Delete everything in Test Co?', 'immediately and permanently', 'Delete everything now'), 'confirmation')
  for (const gone of ['#force-password', '#force-confirm', '#force-code']) assert(!(await evaluate(`Boolean(document.querySelector('${gone}'))`)), `still asks for ${gone}`)
  const before = forceCalls().length
  await click('[role=dialog] button', 'Cancel')
  await waitFor(`!document.querySelector('[role=dialog]')`, 'closed')
  assert(forceCalls().length === before, 'cancel sent a delete')
})

await step('Force reset: "Delete everything now" deletes directly on the server, removes stored files, then the ERP reloads', async () => {
  await click('[data-testid=force-reset-section] button', 'Force Reset / Delete Everything')
  await waitFor(bodyHas('Delete everything now'), 'confirmation')
  await click('[role=dialog] button', 'Delete everything now')
  await waitFor(bodyHasAll('Force reset completed and verified', '51 records and 2 stored files were deleted'), 'success')
  assert(await evaluate(bodyHas('1 stored file(s) could not be removed')), 'leftover document file not reported')
  const call = forceCalls().at(-1).body
  assert(call.p_company_id === COMPANY_ID && /^[0-9a-f-]{36}$/.test(call.p_request_id) && Object.keys(call).length === 2, JSON.stringify(call))
  assert(requests.filter((r) => r.path === '/functions/v1/force-reset-erp-data').length === 0, 'the old Edge Function was called')
  assert(requests.some((r) => r.method === 'DELETE' && r.path === '/storage/v1/object/product-images'), 'product images not removed')
  await screenshot('102-force-reset-done')
  await evaluate('window.__beforeReload = true')
  await click('[role=dialog] button', 'Reload the ERP')
  await waitFor(`!window.__beforeReload && location.pathname === '/admin/erp-settings' && ${bodyHas('Force Reset / Delete Everything')}`, 'reloaded')
})

await step('Force reset: history lists standard and force attempts with results', async () => {
  // Right after the reload the settings page can still re-render once and drop a dialog opened too early; retry the click.
  for (let i = 0; i < 3; i++) {
    await click('[data-testid=force-reset-section] button', 'View Reset History')
    try { await waitFor(`!!document.querySelector('[role=dialog]')`, 'history dialog', 3000); break } catch (e) { if (i === 2) throw e }
  }
  await waitFor(bodyHasAll('Reset history', 'Force', 'completed', 'Standard', 'blocked', 'Stock ledger'), 'history')
  await screenshot('103-reset-history')
  await click('[role=dialog] button', 'Close')
})

// ---------------------------------------------------------------------------
// Department-wise Data Management (Settings → System)
// ---------------------------------------------------------------------------
const deptCalls = (fn) => rpcCalls(fn)
const deptCard = (dept) => `[data-testid=dept-${dept}]`

await step('Department data 1: Super Admin sees seven department cards with categories and counts; buttons need a selection', async () => {
  await goto('/admin/erp-settings?tab=system')
  await waitFor(`!!document.querySelector('[data-testid=department-data-section]') && document.querySelectorAll('[data-testid^=dept-]').length >= 7`, 'section')
  await waitFor(bodyHasAll('Department Data Management', 'Product Master & BOM', 'Inventory Management', 'Purchase & GRN', 'Production & Outsourcing', 'Sales & Orders',
    'Billing & Invoice', 'Ledger', 'Draft and cancelled purchase orders', '1 blocked'), 'cards and categories')
  assert(await evaluate(`[...document.querySelectorAll('${deptCard('PURCHASE')} button')].find((b) => b.innerText.includes('Delete permanently')).disabled`), 'delete enabled without a selection')
  assert(await evaluate(`document.querySelector('[data-category="production.unposted_orders"] button[role=checkbox]').disabled`), 'a category with nothing eligible can be selected')
  await screenshot('140-department-data')
})

await step('Department data 2: Purchase & GRN with 0 eligible and 2 blocked explains why (each record, every reason, the related GRN and stock movement); nothing can be confirmed', async () => {
  await waitFor(`${bodyHasAll('Nothing can be deleted permanently: 2 records are kept because other records depend on them.')} && !!document.querySelector('${deptCard('PURCHASE')} [data-testid=dept-nothing-hint]')`, 'explanation under the disabled button')
  assert(await evaluate(`[...document.querySelectorAll('${deptCard('PURCHASE')} button')].find((b) => b.innerText.includes('Delete permanently')).disabled`), 'delete enabled with nothing eligible')
  assert(await evaluate(`document.querySelector('[data-category="purchase.unposted_orders"]').innerText.includes('0 eligible · 2 blocked')`), 'category counts')
  await screenshot('140b-purchase-nothing-deletable')
  await click('[data-testid="dept-why-purchase.unposted_orders"]')
  await waitFor(`!!document.querySelector('[data-testid=dept-nothing]') && document.querySelectorAll('[data-testid=dept-record][data-state=blocked]').length === 2`, 'explanation dialog')
  const row = (key) => `document.querySelector('[data-testid=dept-record][data-key="${key}"]').innerText`
  const b1 = await evaluate(row('po-b1'))
  for (const t of ['PO-000002', 'PO', 'Cancelled', 'Blocked', 'posted and later reversed', 'Stock movement posted for this order', 'GRN-000001', 'TXN-000004', 'Inventory Management']) assert(b1.includes(t), `PO-000002 row lacks ${t}: ${b1}`)
  const b2 = await evaluate(row('po-b2'))
  for (const t of ['PO-000005', 'Draft (revision 1)', 'amended back to draft', 'Posted goods receipt', 'GRN-000003']) assert(b2.includes(t), `PO-000005 row lacks ${t}: ${b2}`)
  assert(await evaluate(bodyHasAll('Nothing can be deleted permanently.', 'All 2 records below are kept')), 'banner text')
  assert(!(await evaluate(`!!document.querySelector('[data-testid=dept-execute]') || !!document.querySelector('#dept-phrase') || !!document.querySelector('[data-testid=dept-records] button[role=checkbox]')`)),
    'a blocked record can be selected or confirmed')
  assert(deptCalls('department_data_execute').length + deptCalls('department_data_execute_records').length === 0, 'something was executed')
  await screenshot('141-purchase-blocked-reasons')
  await click('[role=dialog] button', 'Close')
  await waitFor(`!document.querySelector('[data-testid=dept-dialog]')`, 'closed')
})

await step('Department data 3: eligible orders and GRN drafts are listed and selectable (blocked ones are not); the delete runs on the selection with its own preview, backup, phrase and password', async () => {
  deptPurchaseState = 'mixed'
  const overviews = rpcCalls('department_data_overview').length
  await click('button[aria-label="Refresh counts"]')
  for (let t = Date.now(); rpcCalls('department_data_overview').length === overviews && Date.now() - t < 3000;) await sleep(100)
  assert(rpcCalls('department_data_overview').length === overviews + 1, 'Refresh counts did not reload the counts')
  await waitFor(`document.querySelector('[data-category="purchase.unposted_orders"]')?.innerText.includes('2 eligible · 2 blocked') && !document.querySelector('${deptCard('PURCHASE')} [data-testid=dept-nothing-hint]')`, 'counts after refresh')
  await click(`[data-category="purchase.unposted_orders"] button[role=checkbox]`)
  await click(`[data-category="purchase.unposted_receipts"] button[role=checkbox]`)
  await click(`${deptCard('PURCHASE')} button`, 'Delete permanently (2)')
  await waitFor(`document.querySelectorAll('[data-testid=dept-record][data-state=eligible]').length === 3 && document.querySelectorAll('[data-testid=dept-record][data-state=blocked]').length === 2`, 'record list')
  assert(await evaluate(`document.querySelector('[data-testid=dept-fig-eligible]').innerText.includes('3')`), 'eligible figure')
  const e1 = await evaluate(`document.querySelector('[data-testid=dept-record][data-key="po-c1"]').innerText`)
  for (const t of ['PO-000011', 'Cancelled', 'Eligible', 'Unposted form drafts: 1', 'Purchase order lines: 1']) assert(e1.includes(t), `PO-000011 row lacks ${t}: ${e1}`)
  assert(await evaluate(`document.querySelector('[data-testid=dept-record][data-key="grn-d1"]').innerText.includes('GRN draft')`), 'GRN draft type')
  assert(await evaluate(`[...document.querySelectorAll('[data-testid=dept-record][data-state=eligible] button[role=checkbox]')].every((c) => c.getAttribute('data-state') === 'checked')`), 'eligible records not selected by default')
  assert(await evaluate(`[...document.querySelectorAll('[data-testid=dept-record][data-state=blocked]')].every((r) => !r.querySelector('button[role=checkbox]'))`), 'a blocked record has a checkbox')
  // Untick the cancelled order: the database previews exactly the selection.
  const before = deptCalls('department_data_preview_records').length
  await click('[data-testid=dept-record][data-key="po-c1"] button[role=checkbox]')
  await waitFor(`document.querySelector('[data-testid=dept-fig-eligible]')?.innerText.includes('2') && ${bodyHas('Delete permanently 2 records')}`, 'narrowed preview')
  const pr = deptCalls('department_data_preview_records').at(-1).body
  assert(deptCalls('department_data_preview_records').length > before && JSON.stringify(pr.p_keys.sort()) === JSON.stringify(['grn-d1', 'po-d1']), JSON.stringify(pr))
  // Nothing selected: the delete stays disabled with the reason.
  // Header checkbox: mixed → all selected (back to 3); again → none selected (delete disabled with the reason).
  await click('[aria-label="Select all eligible records"]')
  await waitFor(`${bodyHas('Delete permanently 3 records')} && document.querySelector('[aria-label="Select all eligible records"]').getAttribute('data-state') === 'checked'`, 'all selected')
  await click('[aria-label="Select all eligible records"]')
  await fill('#dept-phrase', 'DELETE PURCHASE')
  await waitFor(`document.querySelector('[data-testid=dept-execute]').disabled && ${bodyHas('Select at least one eligible record.')}`, 'nothing selected')
  await fill('#dept-phrase', '')
  await click('[aria-label="Select all eligible records"]')
  await click('[data-testid=dept-record][data-key="po-c1"] button[role=checkbox]')
  await waitFor(bodyHas('Delete permanently 2 records'), 'selection back to 2')
  await screenshot('142-purchase-records-selection')
  await fill('#dd-bk-ref', 'Supabase daily backup 04 Nov 02:00')
  await click('#dd-bk-restore')
  await click('#dd-bk-external')
  await click('[data-testid=dept-backup] button', 'Record backup')
  await waitFor(`!!document.querySelector('[data-testid=dept-backup-ok]')`, 'backup recorded')
  await fill('#dept-phrase', 'delete purchase')
  assert(await evaluate(`document.querySelector('[data-testid=dept-execute]').disabled`), 'wrong phrase accepted')
  await fill('#dept-phrase', 'DELETE PURCHASE')
  await fill('#dept-password', 'correct-horse')
  await waitFor(`!document.querySelector('[data-testid=dept-execute]').disabled`, 'execute enabled')
  const tokenCalls = requests.filter((r) => r.path === '/auth/v1/token').length
  await click('[data-testid=dept-execute]')
  await waitFor(`document.querySelector('[data-testid=dept-result]')?.dataset.status === 'COMPLETED'`, 'completed')
  await waitFor(bodyHasAll('Completed', '4 row(s) changed', 'Purchase order history'), 'result counts')
  assert(requests.filter((r) => r.path === '/auth/v1/token').length === tokenCalls + 1, 'password not confirmed with Supabase Auth before the delete')
  assert(deptCalls('department_data_execute').length === 0, 'the all-records function was used for a selection')
  const call = deptCalls('department_data_execute_records').at(-1).body
  assert(call.p_department === 'PURCHASE' && call.p_operation === 'DELETE' && call.p_confirmation === 'DELETE PURCHASE' && call.p_plan_hash === 'hash-PURCHASE-grn-d1+po-d1'
    && JSON.stringify([...call.p_keys].sort()) === '["grn-d1","po-d1"]' && /^bk-/.test(call.p_backup_id) && /^[0-9a-f-]{36}$/.test(call.p_request_id)
    && JSON.stringify(call.p_categories) === '["purchase.unposted_orders","purchase.unposted_receipts"]', JSON.stringify(call))
  assert(!JSON.stringify(call).includes('company'), 'the browser sent a company id')
  await screenshot('143-purchase-delete-done')
  await click('[role=dialog] button', 'Close')
  await waitFor(`!document.querySelector('[data-testid=dept-dialog]') && document.querySelector('[data-category="purchase.unposted_orders"]')?.innerText.includes('1 eligible · 2 blocked')`, 'closed and refreshed')
})

await step('Department data 4: archive needs only the phrase (no backup, no password); a stale preview stops with "preview again"', async () => {
  await click(`[data-category="products.archive_inactive"] button[role=checkbox]`)
  await click(`${deptCard('PRODUCTS')} button`, 'Archive (1)')
  await waitFor(`!!document.querySelector('[data-testid=dept-preview]')`, 'archive preview')
  assert(!(await evaluate(`!!document.querySelector('#dept-password') || !!document.querySelector('[data-testid=dept-backup]')`)), 'archive asks for a backup or password')
  const tokens = requests.filter((r) => r.path === '/auth/v1/token').length
  await fill('#dept-phrase', 'ARCHIVE PRODUCTS')
  await click('[data-testid=dept-execute]')
  await waitFor(`document.querySelector('[data-testid=dept-result]')?.dataset.status === 'COMPLETED'`, 'archived')
  assert(requests.filter((r) => r.path === '/auth/v1/token').length === tokens, 'archive asked for the password')
  await click('[role=dialog] button', 'Close')
  await waitFor(`!document.querySelector('[data-testid=dept-dialog]')`, 'closed')
  // Stale (the mock reports a changed plan for sales orders)
  await click(`[data-category="sales.unposted_orders"] button[role=checkbox]`)
  await click(`${deptCard('SALES')} button`, 'Delete permanently (1)')
  await waitFor(`!!document.querySelector('[data-testid=dept-preview]')`, 'sales preview')
  await fill('#dd-bk-ref', 'pg_dump alton-0405.sql')
  await click('#dd-bk-restore')
  await click('#dd-bk-external')
  await click('[data-testid=dept-backup] button', 'Record backup')
  await waitFor(`!!document.querySelector('[data-testid=dept-backup-ok]')`, 'backup')
  await fill('#dept-phrase', 'DELETE SALES')
  await fill('#dept-password', 'correct-horse')
  await click('[data-testid=dept-execute]')
  await waitFor(`document.querySelector('[data-testid=dept-result]')?.dataset.status === 'BLOCKED' && ${bodyHasAll('Stopped', 'The data changed after the preview', 'Preview again')}`, 'stale preview stopped')
  await click('[role=dialog] button', 'Close')
})

await step('Department data 5: history lists every operation; a user without the Super Admin role does not see the section', async () => {
  await click('[data-testid=department-data-section] button', 'History')
  await waitFor(`${bodyHasAll('Department data history', 'Purchase & GRN', 'Permanent delete', 'COMPLETED', 'BLOCKED', 'Owner Tester')}`, 'history')
  await click('[role=dialog] button', 'Close')
  await signOut()
  await login('manager@test.invalid')
  await waitFor(`location.pathname !== '/login'`, 'manager signed in')
  await goto('/admin/erp-settings?tab=system')
  await waitFor(bodyHas('Security & audit'), 'system settings')
  assert(!(await evaluate(`!!document.querySelector('[data-testid=department-data-section]')`)), 'section shown to a user who is not Super Admin')
  await signOut()
  await login('owner@test.invalid')
  await waitFor(`location.pathname !== '/login'`, 'owner again')
})

const inviteCalls = () => requests.filter((r) => r.path === '/functions/v1/invite-user')
const successNotice = () => evaluate(`[...document.querySelectorAll('[role=status]')].some((e) => e.innerText.includes('Invitation sent'))`)
async function openInviteForm(name, email, roleIds) {
  await goto('/users')
  await waitFor(`[...document.querySelectorAll('main button')].some((b) => b.innerText.includes('Invite User') && !b.disabled)`, 'invite button')
  await click('main button', 'Invite User')
  await waitFor(`document.querySelector('#invite-name')`, 'invite form')
  // The previous attempt is auto-saved and restored on reopening; start from a clean form.
  await waitFor(`document.querySelector('[data-draft-status]') && document.querySelector('[data-draft-status]').dataset.draftStatus !== 'loading'`, 'draft check')
  if (await evaluate(`[...document.querySelectorAll('[role=dialog] button')].some((b) => b.innerText.includes('Discard Draft'))`)) {
    await click('[role=dialog] button', 'Discard Draft')
    await waitFor(`document.querySelector('#invite-name').value === ''`, 'draft discarded')
  }
  await fill('#invite-name', name)
  await fill('#invite-email', email)
  for (const id of roleIds) await click(`#invite-role-${id}`)
}
async function sendInvite() {
  await click('[role=dialog] button', 'Review invitation')
  await waitFor(bodyHas('Confirm invitation'), 'confirmation step')
  await click('[role=dialog] button', 'Send invitation')
}

await step('Invite User: categorised, searchable role cards with admin flags, modules, key permissions and View Permissions; validation before anything is sent', async () => {
  await goto('/users')
  await waitFor(bodyHasAllCI('Users', 'Invitations', 'Administration', 'Sales & Commercial'), 'users page with role catalogue')
  await waitFor(`[...document.querySelectorAll('main button')].some((b) => b.innerText.includes('Invite User') && !b.disabled)`, 'invite button')
  await click('main button', 'Invite User')
  await waitFor(bodyHasAllCI('Full name', 'Work email', 'Employee ID', 'Department', 'Designation', 'Reporting manager', 'Dispatch & Fulfilment', 'Finance & Accounts'), 'invite form')
  assert(await evaluate(bodyHasAll('Modules: Customers, Sales orders', 'Key permissions: Create sales orders', 'No roles selected')), 'role card details missing')
  assert(await evaluate(`document.querySelectorAll('[role=dialog] [data-role-code=SUPER_ADMIN]').length === 1 && document.querySelector('[role=dialog] [data-role-code=ADMIN]').innerText.includes('Admin')`), 'admin flag missing')
  await click('[role=dialog] [data-role-code=SALES_EXECUTIVE] button', 'View permissions')
  await waitFor(bodyHasAll('sales_orders.create', 'Hide permissions'), 'permissions list')
  await fill('[role=dialog] input[aria-label="Search roles"]', 'dispatch')
  await waitFor(`!document.querySelector('[role=dialog] [data-role-code=SALES_EXECUTIVE]') && document.querySelector('[role=dialog] [data-role-code=DISPATCH_EXECUTIVE]')`, 'search filters roles')
  await fill('[role=dialog] input[aria-label="Search roles"]', '')
  const before = inviteCalls().length
  await click('[role=dialog] button', 'Review invitation')
  await waitFor(bodyHasAll('Enter the employee’s full name.', 'Enter the work e-mail address.', 'Select at least one role.'), 'validation messages')
  assert(inviteCalls().length === before, 'a request was sent for an invalid form')
  await click('#invite-role-r-sales')
  await click('#invite-role-r-dispatch')
  await waitFor(bodyHas('Selected (2):'), 'selected summary')
  await click('[role=dialog] button', 'Clear selection')
  await waitFor(bodyHas('No roles selected'), 'cleared')
  await screenshot('104-invite-form')
  await click('[role=dialog] button', 'Cancel')
})

await step('Invite User: confirmation summary, then one call to the invite-user Edge Function (no company or inviter sent); success only after the server confirms', async () => {
  await openInviteForm('Asha Rao', 'Asha.Rao@Test.invalid', ['r-sales', 'r-admin'])
  await fill('#invite-designation', 'Sales Lead')
  await fill('#invite-employee-id', 'EMP-042')
  await click('[role=dialog] button', 'Review invitation')
  await waitFor(bodyHasAll('Confirm invitation', 'asha.rao@test.invalid', 'Sales Lead', 'EMP-042', 'Roles (2)', 'administrative role'), 'confirmation summary')
  await screenshot('105-invite-confirm')
  const before = inviteCalls().length
  await click('[role=dialog] button', 'Send invitation')
  await waitFor(bodyHas('Invitation sent to asha.rao@test.invalid'), 'success notice')
  assert(inviteCalls().length === before + 1, 'expected exactly one invite call')
  const call = inviteCalls().at(-1).body
  assert(call.action === 'invite' && call.email === 'asha.rao@test.invalid' && call.full_name === 'Asha Rao' && /^[0-9a-f-]{36}$/.test(call.idempotency_key), JSON.stringify(call))
  assert(JSON.stringify(call.role_ids.sort()) === JSON.stringify(['r-admin', 'r-sales']), 'roles not sent')
  assert(!('company_id' in call) && !('invited_by' in call) && !('user_id' in call), 'the browser sent a company, inviter or user id')
  await waitFor(`location.search.includes('tab=invitations') && ${bodyHasAllCI('Employee Name', 'Assigned Roles', 'Invitation Date', 'Invited By', 'Expiry', 'Invitation Status', 'Email Status')}`, 'invitations tab')
  await waitFor(bodyHasAll('Asha Rao', 'asha.rao@test.invalid', 'Pending', 'Sent'), 'new invitation listed')
})

await step('Invite User: duplicate, e-mail failure and network failure show clear errors and never a success message', async () => {
  for (const [email, expected] of [
    ['asha.rao@test.invalid', 'already exists. Resend it instead of inviting again.'],
    ['fail.user@test.invalid', 'The invitation e-mail could not be sent.'],
    ['offline.user@test.invalid', 'could not be reached (network problem)'],
  ]) {
    await openInviteForm('Some One', email, ['r-sales'])
    await sendInvite()
    await waitFor(`[...document.querySelectorAll('[role=dialog] [role=alert]')].some((e) => e.innerText.includes(${JSON.stringify(expected)}))`, `error for ${email}`)
    assert(!(await successNotice()), `success shown for ${email}`)
    assert(await evaluate(bodyHas('Confirm invitation')), 'dialog closed after a failure')
    const key = inviteCalls().at(-1).body.idempotency_key
    if (email.startsWith('offline')) {
      // Retrying the same reviewed form reuses the request id, so a lost reply cannot create a second invitation.
      await click('[role=dialog] button', 'Send invitation')
      await waitFor(`[...document.querySelectorAll('[role=dialog] [role=alert]')].length > 0`, 'retry error')
      assert(inviteCalls().at(-1).body.idempotency_key === key, 'retry used a new idempotency key')
      await screenshot('106-invite-network-error')
    }
    await click('[role=dialog] button', 'Back')
    await click('[role=dialog] button', 'Cancel')
  }
})

await step('Invitations: statuses, e-mail status, Resend, Revoke with a reason, View Details and Edit roles after activation', async () => {
  await goto('/users?tab=invitations')
  await waitFor(bodyHasAll('Accepted User', 'Late User', 'Bounce User', 'Expired', 'Failed', 'Accepted'), 'invitation list')
  await click('[role=group][aria-label="Invitation status"] button', 'Failed')
  await waitFor(`${bodyHas('Bounce User')} && !(${bodyHas('Late User')})`, 'status filter')
  await click('[role=group][aria-label="Invitation status"] button', 'All')
  const row = (name) => `[...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes(${JSON.stringify(name)}))`
  assert(await evaluate(`!${row('Accepted User')}.innerText.includes('Resend') && ${row('Accepted User')}.innerText.includes('Edit roles')`), 'accepted row actions wrong')
  await evaluate(`${row('Late User')}.querySelectorAll('button').forEach((b) => b.innerText.includes('Resend') && b.setAttribute('data-test', 'resend-late'))`)
  await click('[data-test=resend-late]')
  await waitFor(bodyHas('Invitation resent to late.user@test.invalid'), 'resent')
  const resend = inviteCalls().at(-1).body
  assert(resend.action === 'resend' && resend.invitation_id === 'inv-late.user@test.invalid' && /^[0-9a-f-]{36}$/.test(resend.idempotency_key), JSON.stringify(resend))
  await evaluate(`${row('Bounce User')}.querySelectorAll('button').forEach((b) => b.innerText.includes('Revoke') && b.setAttribute('data-test', 'revoke-bounce'))`)
  await click('[data-test=revoke-bounce]')
  await waitFor(bodyHas('Revoke invitation?'), 'revoke dialog')
  await click('[role=dialog] button', 'Revoke invitation')
  await waitFor(bodyHas('Give a short reason'), 'reason required')
  await fill('#revoke-reason', 'Wrong e-mail address')
  await click('[role=dialog] button', 'Revoke invitation')
  await waitFor(bodyHas('The invitation to bounce.user@test.invalid was revoked.'), 'revoked')
  assert(inviteCalls().at(-1).body.reason === 'Wrong e-mail address', 'reason not sent')
  await waitFor(`${row('Bounce User')} && ${row('Bounce User')}.innerText.includes('Revoked')`, 'revoked status')
  await evaluate(`${row('Bounce User')}.querySelectorAll('button').forEach((b) => b.innerText.includes('Details') && b.setAttribute('data-test', 'details-bounce'))`)
  await click('[data-test=details-bounce]')
  await waitFor(bodyHasAll('Invitation details', 'Wrong e-mail address', 'Invitation links are never stored or shown'), 'details')
  await click('[role=dialog] button', 'Close')
  await evaluate(`${row('Accepted User')}.querySelectorAll('button').forEach((b) => b.innerText.includes('Edit roles') && b.setAttribute('data-test', 'edit-accepted'))`)
  await click('[data-test=edit-accepted]')
  await waitFor(bodyHasAll('Roles for Smoke Tester', 'Save roles'), 'role editor for the activated user')
  await screenshot('107-invitations')
  await click('[role=dialog] button', 'Cancel')
})

await step('Invite User: an Admin who is not a Super Admin cannot select Super Admin or other administrative roles', async () => {
  await signOut()
  await login('manager@test.invalid')
  await waitFor(`location.pathname !== '/login'`, 'manager signed in')
  await goto('/users')
  await waitFor(`[...document.querySelectorAll('main button')].some((b) => b.innerText.includes('Invite User') && !b.disabled)`, 'invite button')
  await click('main button', 'Invite User')
  await waitFor(`document.querySelector('#invite-role-r-super')`, 'role cards')
  assert(await evaluate(`document.querySelector('#invite-role-r-super').disabled && document.querySelector('#invite-role-r-admin').disabled && !document.querySelector('#invite-role-r-sales').disabled`), 'admin roles selectable')
  assert(await evaluate(bodyHas('Only a Super Admin can assign this role.')), 'reason not shown')
  await click('[role=dialog] button', 'Cancel')
  await signOut()
})

await step('Accept invitation: invalid or used links and revoked invitations are refused with a clear message; nothing is activated', async () => {
  await goto('/accept-invitation#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')
  await waitFor(bodyHasAll('Invitation link invalid or expired', 'Email link is invalid or has expired', 'Ask your administrator to resend'), 'invalid link')
  await goto('/accept-invitation?token_hash=revokedhash123&type=invite')
  await waitFor(bodyHasAll('Invitation not available', 'This invitation was revoked', 'support@test.invalid'), 'revoked invitation')
  assert(rpcCalls('user_invitation_accept').length === 0, 'accept called for a revoked invitation')
  assert(await evaluate(`!location.search.includes('token_hash')`), 'token left in the address bar')
  await click('button', 'Sign out')
  await waitFor(`location.pathname === '/login'`, 'signed out')
  await goto('/accept-invitation?token_hash=revokedhash123&type=invite')
  await waitFor(bodyHas('Invitation link invalid or expired'), 'a used link does not work twice')
})

await step('Accept invitation: link verified, password set, account activated and the dashboard opens with the invited roles', async () => {
  await goto('/accept-invitation?token_hash=validhash123&type=invite')
  await waitFor(bodyHasAll('Join Test Co', 'Welcome, New Hire', 'new.hire@test.invalid', 'Sales Executive', 'Set password & activate'), 'invitation page')
  assert(!(await evaluate(bodyHas('Keep my current password'))), 'password step can be skipped from an e-mail link')
  await screenshot('108-accept-invitation')
  await fill('#invite-password', 'short')
  await click('button', 'Set password & activate')
  await waitFor(bodyHas('Use at least 8 characters.'), 'password rule')
  assert(rpcCalls('user_invitation_accept').length === 0, 'accepted before a valid password')
  await fill('#invite-password', 'a-strong-password')
  await fill('#invite-password-confirm', 'a-strong-password')
  await click('button', 'Set password & activate')
  await waitFor(`location.pathname === '/'`, 'dashboard opened')
  assert(rpcCalls('user_invitation_accept').length === 1, 'accept not called exactly once')
  assert(requests.some((r) => r.path === '/auth/v1/user' && r.method === 'PUT' && r.body?.password === 'a-strong-password'), 'password not set through Supabase Auth')
  assert(Object.keys(rpcCalls('user_invitation_accept')[0].body ?? {}).length === 0, 'the browser sent data to the accept call')
})

await step('read-only user sees no write controls and cannot open the add form', async () => {
  await signOut()
  await login('viewer@test.invalid')
  // Returns to the page the user was on before signing out.
  await waitFor(`location.pathname !== '/login'`, 'signed in')
  await goto('/products')
  await waitFor(bodyHas('MOCK-WC-1'), 'list')
  for (const text of ['Add Product', 'Import from Excel', 'Export']) {
    assert(!(await evaluate(`[...document.querySelectorAll('button, a')].some((e) => e.innerText.trim() === ${JSON.stringify(text)})`)), `viewer can see "${text}"`)
  }
  await goto('/products/new')
  await waitFor(bodyHas("You don't have permission to view this page"), 'access denied')
  await screenshot('09-viewer-denied')
})

await step('read-only user sees inventory but no stock-changing actions', async () => {
  await goto('/inventory/movements')
  await waitFor(bodyHas('TXN-000001'), 'movements')
  for (const text of ['Receive', 'Issue', 'Transfer']) {
    assert(!(await evaluate(`[...document.querySelectorAll('button')].some((e) => e.innerText.trim() === ${JSON.stringify(text)})`)), `viewer can see "${text}"`)
  }
  await goto('/inventory/opening-stock/import')
  await waitFor(bodyHas("You don't have permission to view this page"), 'import denied')
})

await step('read-only user sees production but no workflow or posting actions', async () => {
  await goto('/production/orders/po1')
  await waitFor(bodyHasAll('PRD-000001', 'Material issues'), 'order page')
  for (const text of ['Issue materials', 'Record output', 'Complete order', 'Put on hold', 'Cancel order', 'Reserve materials']) {
    assert(!(await evaluate(`[...document.querySelectorAll('button')].some((e) => e.innerText.trim() === ${JSON.stringify(text)})`)), `viewer can see "${text}"`)
  }
  await goto('/production/boms')
  await waitFor(bodyHas('BOM-000001'), 'bom list')
  assert(!(await evaluate(bodyHas('New BOM'))), 'viewer can create BOMs')
  assert(await evaluate(bodyHas('Compare BOMs')) && !(await evaluate(bodyHas('BOM templates'))) && !(await evaluate(bodyHas('Create similar product'))) && !(await evaluate(bodyHas('Generate multiple'))), 'viewer BOM tools')
  await goto('/production/boms/generate?source=bom1')
  await waitFor(bodyHas("You don't have permission to view this page"), 'generate multiple denied')
  await goto('/production/planning')
  await waitFor(bodyHas("You don't have permission to view this page"), 'planning denied')
})

await step('read-only user sees purchase orders and goods received but cannot create, receive or correct', async () => {
  // Management Viewer has purchases.read only: sees orders, no order or receipt actions.
  await goto('/purchase-orders')
  await waitFor(bodyHas('PO-000003'), 'viewer po list')
  assert(!(await evaluate(bodyHas('New Purchase Order'))) && !(await evaluate(bodyHas('Import from Excel'))), 'viewer can create or import POs')
  await goto('/purchase-orders/po2')
  await waitFor(bodyHas('PO-000002'), 'viewer po detail')
  assert(!(await evaluate(`[...document.querySelectorAll('button, a')].some((b) => ['Approve', 'Reject', 'Record goods receipt', 'Print / PDF', 'Cancel order'].includes(b.innerText.trim()))`)), 'viewer sees PO actions')
  await goto('/purchase-orders/new')
  await waitFor(bodyHas("You don't have permission to view this page"), '/purchase-orders/new denied')
  await goto('/goods-receipts')
  await waitFor(bodyHas('GRN-000001'), 'viewer grn list')
  assert(!(await evaluate(bodyHas('Receive without PO'))) && !(await evaluate(bodyHas('Receive against PO'))), 'viewer can receive goods')
  await goto('/goods-receipts/gr1')
  await waitFor(bodyHas('Items received'), 'viewer grn detail')
  assert(!(await evaluate(`[...document.querySelectorAll('button')].some((b) => ['Correct', 'Reverse'].includes(b.innerText.trim()))`)), 'viewer can correct or reverse')
})

await step('read-only user sees sales orders but cannot create, import or cancel', async () => {
  await goto('/sales/orders')
  await waitFor(bodyHas('SO-000001'), 'order list')
  for (const text of ['New sales order', 'Import from Excel']) {
    assert(!(await evaluate(`[...document.querySelectorAll('main button, main a')].some((b) => b.innerText.includes(${JSON.stringify(text)}))`)), `viewer can see "${text}"`)
  }
  await goto('/sales/cancellation?so=so2')
  await waitFor(bodyHas('needs the sales_orders.cancel permission'), 'cancel blocked')
})

await step('read-only user sees billing but cannot create, issue, record payments, export or change settings', async () => {
  await goto('/billing/invoices/inv1')
  await waitFor(bodyHasAll('Acme Ltd', 'Lines'), 'invoice page')
  for (const text of ['Issue invoice', 'Save draft', 'Discard', 'Refresh from masters']) {
    assert(!(await evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.includes(${JSON.stringify(text)}))`)), `viewer can see "${text}"`)
  }
  await goto('/billing/payments')
  await waitFor(bodyHas('RCT/26-27/0001'), 'payments')
  assert(!(await evaluate(`[...document.querySelectorAll('button')].some((b) => ['Record payment', 'Export'].some((t) => b.innerText.includes(t)))`)), 'viewer can record or export')
  await goto('/billing/invoices/new')
  await waitFor(bodyHas("You don't have permission to view this page"), 'create denied')
  await goto('/billing/settings')
  await waitFor(bodyHas("You don't have permission to view this page"), 'settings denied')
  await goto('/billing/reports')
  await waitFor(bodyHasAll('Invoice register', 'INV/26-27/0001'), 'reports')
  assert(!(await evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.includes('Export'))`)), 'viewer can export')
})

await step('read-only user sees the Management Dashboard but no settings or user administration in the menu', async () => {
  await goto('/')
  await waitFor(bodyHasAll('Management Dashboard', 'Total stock', 'Outstanding Receivables (Excl. GST)'), 'dashboard for viewer')
  for (const href of ['/admin/erp-settings', '/users', '/audit-logs']) {
    assert(!(await evaluate(`!!document.querySelector('aside a[href="${href}"]')`)), `viewer sees ${href} in the menu`)
  }
})

await step('read-only user: administration pages denied', async () => {
  for (const p of ['/admin/erp-settings', '/admin/bulk-operations', '/audit-logs', '/users']) {
    await goto(p)
    await waitFor(bodyHas("You don't have permission to view this page"), `${p} denied`)
  }
})

// ---------------------------------------------------------------------------
// Dashboard drill-down: every figure opens the records behind it
// ---------------------------------------------------------------------------
const lastQuery = (path) => decodeURIComponent((requests.filter((r) => r.path === path).at(-1)?.query ?? '').split('+').join(' '))
const kpiLink = (label) => `[...document.querySelectorAll('a[data-drill=kpi]')].find((a) => a.innerText.includes(${JSON.stringify(label)}))`

await step('Drill-down 1: a dashboard figure is a link (mouse and keyboard) to its records; the list has the same count and is filtered on the server', async () => {
  await signOut()
  await login('manager@test.invalid')
  await waitFor(`location.pathname !== '/login'`, 'manager signed in')
  await goto('/purchase-orders/dashboard?from=2026-11-01&to=2026-11-30&range=custom')
  await waitFor(`!!${kpiLink('Open POs')} && !!${kpiLink('Overdue Deliveries')}`, 'clickable figures')
  assert(await evaluate(`document.querySelectorAll('a[data-drill=kpi]').length === 7`), 'not every purchase figure is clickable')
  const shown = await evaluate(`${kpiLink('Open POs')}.innerText.match(/Open POs\\s+(\\d+)/)[1]`)
  await screenshot('130-drill-kpis')
  // Keyboard: the card is a focusable link; Enter opens it.
  await evaluate(`${kpiLink('Open POs')}.focus()`)
  for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await waitFor(`location.pathname === '/drilldown/purchase.open'`, 'drill-down page')
  await waitFor(`document.querySelector('[data-testid=drill-count]')?.innerText.startsWith('${shown} ')`, 'same count as the card')
  assert(lastQuery('/rest/v1/purchase_order_list_excl_gst').includes('status=in.(APPROVED,SENT,PARTIALLY_RECEIVED)'), lastQuery('/rest/v1/purchase_order_list_excl_gst'))
  await waitFor(`${bodyHasAll('Open POs', 'Purchase Dashboard', 'PO-000003', 'Rule: status in Approved, Sent, Partially received')} && !document.querySelector('[data-testid=drill-table]').innerText.includes('PO-000001')`, 'records and rule')
  assert(await evaluate(`[...document.querySelectorAll('nav[aria-label=Breadcrumb] a')].some((a) => a.innerText.includes('Purchase Dashboard') && a.getAttribute('href').includes('from=2026-11-01'))`), 'breadcrumb back to the dashboard with its period')
  await screenshot('131-drill-page')
})

await step('Drill-down 2: search, sort and columns run on the server; a record opens and Back returns to the same list', async () => {
  await fill('input[aria-label="Search records"]', 'PO-0000')
  await waitFor(`location.search.includes('q=PO-0000')`, 'search in the address')
  for (let i = 0; i < 30 && !lastQuery('/rest/v1/purchase_order_list_excl_gst').includes('po_number.ilike.%PO-0000%'); i++) await sleep(100)
  assert(lastQuery('/rest/v1/purchase_order_list_excl_gst').includes('or=(po_number.ilike.%PO-0000%'), lastQuery('/rest/v1/purchase_order_list_excl_gst'))
  await click('[data-testid=drill-table] th button', 'Value')
  await waitFor(`location.search.includes('sort=taxable_total')`, 'sorted')
  for (let i = 0; i < 30 && !lastQuery('/rest/v1/purchase_order_list_excl_gst').includes('order=taxable_total.asc'); i++) await sleep(100)
  assert(lastQuery('/rest/v1/purchase_order_list_excl_gst').includes('order=taxable_total.asc'), 'sort not sent to the server')
  await click('button', 'Columns')
  await waitFor(bodyHas('Pending (excl. GST)'), 'column picker')
  await click('[role=dialog] label', 'Warehouse')
  await waitFor(`[...document.querySelectorAll('[data-testid=drill-table] th')].some((th) => th.innerText === 'Warehouse')`, 'column shown')
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await click('[data-testid=drill-table] a', 'PO-000003')
  await waitFor(`location.pathname === '/purchase-orders/po3'`, 'original record')
  await evaluate('history.back()')
  await waitFor(`location.pathname === '/drilldown/purchase.open' && location.search.includes('q=PO-0000') && ${bodyHas('PO-000003')}`, 'back to the same list')
  await click('[data-testid=drill-table] ~ * button, button', 'Clear filters')
  await waitFor(`!location.search.includes('q=') && document.querySelector('input[aria-label="Search records"]').value === ''`, 'filters cleared')
  await click('nav[aria-label=Breadcrumb] a', 'Purchase Dashboard')
  await waitFor(`location.pathname === '/purchase-orders/dashboard' && location.search.includes('from=2026-11-01') && location.search.includes('to=2026-11-30')`, 'dashboard with the same period')
})

await step('Drill-down 3: chart bars and their table view open the records of that bar', async () => {
  await waitFor(`!!document.querySelector('.recharts-bar-rectangle path')`, 'supplier chart')
  await click('.recharts-bar-rectangle path')
  await waitFor(`location.pathname === '/drilldown/purchase.supplier' && new URLSearchParams(location.search).get('seg') === 'Shree Clay Works Pvt Ltd'`, 'bar opens that supplier')
  await waitFor(bodyHasAll('Orders by Supplier', 'supplier name = Shree Clay Works Pvt Ltd'), 'supplier rule')
  assert(lastQuery('/rest/v1/purchase_order_list_excl_gst').includes('supplier_name=eq.Shree Clay Works Pvt Ltd') && lastQuery('/rest/v1/purchase_order_list_excl_gst').includes('po_date=gte.2026-11-01'), lastQuery('/rest/v1/purchase_order_list_excl_gst'))
  await evaluate('history.back()')
  await waitFor(`location.pathname === '/purchase-orders/dashboard'`, 'back')
  await waitFor(`!!document.querySelector('button[aria-label="Table view"]')`, 'table view toggle')
  await click('button[aria-label="Table view"]')
  await waitFor(`[...document.querySelectorAll('table a')].some((a) => a.innerText.includes('Shree Clay Works'))`, 'table view links (keyboard alternative)')
  assert(await evaluate(`[...document.querySelectorAll('table a')].find((a) => a.innerText.includes('Shree Clay Works')).getAttribute('href').startsWith('/drilldown/purchase.supplier?')`), 'table link')
  await goto('/')
  await waitFor(bodyHas('Pending GRNs'), 'management dashboard')
  assert(await evaluate(`document.querySelectorAll('a[data-drill=kpi]').length === 9`), 'not every management figure is clickable')
  assert(await evaluate(`document.querySelector('[data-testid=kpi-invoiced-sales]').getAttribute('href').startsWith('/drilldown/billing.issued_period?')`), 'invoiced sales link')
})

await step('Drill-down 4: Product Master figures open the Product Master list with the figure applied; Clear filters shows every product again', async () => {
  await goto('/products/dashboard')
  await waitFor(`!!${kpiLink('Total Products')}`, 'products dashboard')
  await click('a[data-drill=kpi]', 'Components')
  await waitFor(`location.pathname === '/products' && location.search.includes('drill=products.components') && !!document.querySelector('[data-testid=drill-banner]')`, 'Product Master with the figure')
  await waitFor(bodyHasAll('Components from the Product Dashboard', 'Components and subassemblies, not archived.'), 'banner text')
  assert(lastQuery('/rest/v1/products').includes('product_type=in.(COMPONENT,SUBASSEMBLY)') && lastQuery('/rest/v1/products').includes('archived_at=is.null'), lastQuery('/rest/v1/products'))
  await screenshot('132-drill-product-master')
  await click('[data-testid=drill-banner] button', 'Clear filters')
  await waitFor(`!document.querySelector('[data-testid=drill-banner]') && !location.search.includes('drill=')`, 'cleared')
  await goto('/products/dashboard')
  await waitFor(`!!${kpiLink('Low Stock Products')}`, 'products dashboard again')
  await click('a[data-drill=kpi]', 'Low Stock Products')
  await waitFor(`location.pathname === '/drilldown/products.low_stock'`, 'stock figure opens the stock list')
  assert(lastQuery('/rest/v1/inventory_product_stock').includes('or=(stock_status.eq.LOW_STOCK,and(stock_status.eq.OUT_OF_STOCK,has_history.is.true))'), lastQuery('/rest/v1/inventory_product_stock'))
})

await step('Drill-down 5: the other dashboards link their figures; the period and filters travel with the link', async () => {
  for (const [path, label, key] of [['/inventory', 'Low-Stock Products', 'inventory.low_stock'], ['/production', 'Total Production Orders', 'production.orders'],
    ['/sales/dashboard', 'Pending Orders', 'sales.pending'], ['/billing/dashboard', 'Outstanding', 'billing.outstanding'], ['/goods-receipts/dashboard', 'Unlinked GRNs', 'grn.unlinked'],
    ['/ledger/dashboard', 'Outstanding Receivables (Excl. GST)', 'ledger.receivables']]) {
    await goto(path)
    await waitFor(`!!${kpiLink(label)}`, `${path}: ${label} is a link`)
    assert(await evaluate(`${kpiLink(label)}.getAttribute('href').startsWith('/drilldown/${key}?')`), `${path}: ${label} → ${key}`)
  }
  await goto('/billing/dashboard?from=2026-10-01&to=2026-10-31&range=custom&payment=OVERDUE')
  await waitFor(`!!${kpiLink('Total invoices')}`, 'filtered invoice dashboard')
  const href = await evaluate(`${kpiLink('Total invoices')}.getAttribute('href')`)
  assert(href.includes('from=2026-10-01') && href.includes('to=2026-10-31') && href.includes('payment=OVERDUE'), href)
  await click('a[data-drill=kpi]', 'Total invoices')
  await waitFor(`location.pathname === '/drilldown/billing.total' && !!document.querySelector('[data-testid=drill-chip]')`, 'filter chip')
  assert(lastQuery('/rest/v1/sales_invoice_list_excl_gst').includes('display_status=eq.OVERDUE') && lastQuery('/rest/v1/sales_invoice_list_excl_gst').includes('invoice_date=gte.2026-10-01'), lastQuery('/rest/v1/sales_invoice_list_excl_gst'))
  await click('button[aria-label^="Remove Payment"]')
  await waitFor(`!location.search.includes('payment=') && !document.querySelector('[data-testid=drill-chip]')`, 'chip removed')
  await goto('/sales/dashboard')
  await waitFor(`!!${kpiLink('Pending Orders')}`, 'sales dashboard')
  await click('a[data-drill=kpi]', 'Pending Orders')
  await waitFor(`location.pathname === '/drilldown/sales.pending' && !!document.querySelector('[data-testid=drill-count]')`, 'sales records (status computed by the database)')
  assert(rpcCalls('sales_orders_v2_list_excl_gst').length > 0, 'sales list not read from the database function')
})

// ---------------------------------------------------------------------------
// List pages: summary cards open their records; tabs survive Back
// ---------------------------------------------------------------------------
const pressed = (label) => `[...document.querySelectorAll('[role=group] button[aria-pressed=true]')].some((b) => b.innerText.startsWith(${JSON.stringify(label)}))`

await step('List cards 1: every Product Master card is a link; Missing Information shows the products, their missing fields and completion; Clear removes it', async () => {
  await goto('/products')
  await waitFor(`document.querySelectorAll('a[data-drill=kpi]').length === 6`, 'six clickable cards')
  await waitFor(`[...document.querySelectorAll('[role=group][aria-label=Status] button')].some((b) => /Active\\s*\\d+/.test(b.innerText))`, 'status tabs with counts')
  const shown = await evaluate(`document.querySelector('[data-testid=pm-card-incomplete]').innerText.match(/Missing Information\\s+(\\d+)/)[1]`)
  await click('[data-testid=pm-card-incomplete]')
  await waitFor(`location.pathname === '/products' && location.search.includes('drill=pm.incomplete') && !!document.querySelector('[data-testid=drill-banner]')`, 'filtered Product Master')
  // Table headings are styled in capitals; the column itself is checked below.
  await waitFor(bodyHas('Products with Missing Information'), 'filter heading')
  assert(await evaluate(`document.querySelector('[data-testid=pm-card-incomplete]').dataset.active === 'true'`), 'selected card not highlighted')
  const q = lastQuery('/rest/v1/products')
  assert(q.includes('status=eq.ACTIVE') && q.includes('or=(hsn_code.is.null,gst_rate.is.null,category_id.is.null,and(product_type.eq.FINISHED_GOOD,selling_price.is.null)'), q)
  await waitFor(`document.querySelectorAll('[data-testid=pm-missing]').length > 0`, 'missing fields per product')
  assert(await evaluate(`[...document.querySelectorAll('[data-testid=pm-missing]')].every((c) => /of 4 complete/.test(c.innerText))`), 'completion not shown')
  assert(await evaluate(`document.querySelectorAll('[data-testid=pm-missing]').length === ${shown}`), `the list does not have ${shown} products`)
  await screenshot('150-missing-information')
  await click('[data-testid=drill-banner] button', 'Clear filters')
  await waitFor(`!document.querySelector('[data-testid=drill-banner]') && !location.search.includes('drill=') && !document.querySelector('[data-testid=pm-missing]')`, 'cleared')
})

await step('List cards 2: Product Master filters live in the address: a free-format SKU search and the status tab survive opening a product and Back', async () => {
  await click('[role=group][aria-label=Status] button', 'Inactive')
  await waitFor(`new URLSearchParams(location.search).get('status') === 'inactive'`, 'status in the address')
  await click('[role=group][aria-label=Status] button', 'All current')
  await fill('input[aria-label="Search products"]', 'WC 200 #A')
  await waitFor(`new URLSearchParams(location.search).get('q') === 'WC 200 #A'`, 'search in the address')
  for (let i = 0; i < 30 && !lastQuery('/rest/v1/products').includes('"%WC 200 #A%"'); i++) await sleep(100)
  assert(lastQuery('/rest/v1/products').includes('sku.ilike."%WC 200 #A%"'), 'free-format search not sent as typed: ' + lastQuery('/rest/v1/products'))
  await fill('input[aria-label="Search products"]', '')
  await click('[role=group][aria-label=Status] button', 'Active')
  await waitFor(`new URLSearchParams(location.search).get('status') === 'active' && document.querySelectorAll('tbody a[href^="/products/"]').length > 0`, 'active list')
  await click('tbody a[href^="/products/"]')
  await waitFor(`/^\\/products\\/[^/]+$/.test(location.pathname)`, 'product details')
  await evaluate('history.back()')
  await waitFor(`location.pathname === '/products' && new URLSearchParams(location.search).get('status') === 'active' && ${pressed('Active')}`, 'Back keeps the tab')
})

await step('Product Master columns: Product Name, SKU, Category, Cost, MRP, HSN, GST, Unit, Status; missing values flagged; Cost sorts on the server; an edit shows at once', async () => {
  await goto('/products')
  await waitFor(`document.querySelectorAll('tbody tr').length > 0`, 'product rows')
  const heads = await evaluate(`[...document.querySelectorAll('thead th')].map((th) => th.innerText.trim().toLowerCase()).filter(Boolean)`)
  assert(JSON.stringify(heads.slice(0, 12)) === JSON.stringify(['product name', 'sku', 'category', 'cost', 'last purchase cost', 'last purchase date', 'cost change', 'mrp', 'hsn', 'gst', 'unit', 'status']), JSON.stringify(heads))
  assert(await evaluate(`[...document.querySelectorAll('td[data-col=gst]')].some((c) => c.innerText.trim() === '18%')`), 'GST shown as a percentage')
  assert(await evaluate(`[...document.querySelectorAll('td[data-col=hsn]')].some((c) => c.innerText.trim() === '6910')`), 'HSN shown as stored')
  // Products without an HSN code or GST rate show "Missing"; a cost that is not entered shows "—".
  assert(await evaluate(`[...document.querySelectorAll('td[data-col=hsn], td[data-col=gst]')].some((c) => c.innerText.includes('Missing'))`), 'missing values not flagged')
  assert(await evaluate(`[...document.querySelectorAll('td[data-col=cost]')].some((c) => c.innerText.trim() === '—')`), 'missing cost not shown as —')
  assert(await evaluate(`[...document.querySelectorAll('td[data-col=mrp]')].some((c) => c.innerText.trim() === '—')`), 'missing MRP not shown as —')
  // MRP comes from the MRP field only: a product with a selling price and no MRP shows "—".
  assert(await evaluate(`[...document.querySelectorAll('tbody tr')].some((r) => r.innerText.includes('MOCK-WC-1') && r.querySelector('td[data-col=mrp]').innerText.trim() === '—')`), 'MRP replaced by another price')
  assert(!(await evaluate(bodyHas('HSN / GST'))), 'the old combined column is still there')
  const before = requests.length
  await click('th button', 'COST') // headings are styled in capitals
  await waitFor(`new URLSearchParams(location.search).get('sort') === 'master_cost'`, 'sorted by cost')
  for (let i = 0; i < 30 && !requests.slice(before).some((r) => r.path === '/rest/v1/products' && r.query.includes('order=master_cost.asc')); i++) await sleep(100)
  assert(requests.slice(before).some((r) => r.path === '/rest/v1/products' && r.query.includes('order=master_cost.asc')), 'cost sort not sent to the database')
  assert(requests.slice(before).some((r) => r.relation === 'product_master_list' && r.query.includes('order=master_cost.asc')), 'the list does not read the Product Master Cost view')
  await click('th button', 'MRP')
  await waitFor(`new URLSearchParams(location.search).get('sort') === 'mrp'`, 'sorted by MRP')
  for (let i = 0; i < 30 && !requests.some((r) => r.path === '/rest/v1/products' && r.query.includes('order=mrp.asc')); i++) await sleep(100)
  assert(requests.some((r) => r.path === '/rest/v1/products' && r.query.includes('order=mrp.asc')), 'MRP sort not sent to the database')
  await click('th button', 'MRP')
  await waitFor(`new URLSearchParams(location.search).get('sort') === '-mrp'`, 'MRP descending')
  await goto('/')
  await waitFor(bodyHas('Management Dashboard'), 'away')
  await evaluate('history.back()')
  await waitFor(`location.pathname === '/products' && new URLSearchParams(location.search).get('sort') === '-mrp' && [...document.querySelectorAll('th button')].some((b) => b.innerText.includes('GST'))`, 'Back keeps the MRP sort')
  await click('th button', 'GST')
  await waitFor(`new URLSearchParams(location.search).get('sort') === 'gst_rate'`, 'sorted by GST')
  await screenshot('155-product-columns')
  // Edit: one Cost field (no separate purchase / manufacturing cost); the list shows the saved Cost (two decimals, rupees).
  await goto('/products/p2/edit')
  await waitFor(`!!document.querySelector('#p-standard_cost')`, 'edit form')
  assert(!(await evaluate(`!!document.querySelector('#p-standard_manufacturing_cost') || ${bodyHas('Standard Purchase Cost')}`)), 'old cost fields still on the form')
  assert(await evaluate(`[...document.querySelectorAll('label')].some((l) => l.htmlFor === 'p-standard_cost' && l.innerText.trim().startsWith('Standard Manufacturing Cost'))`), 'standard cost label')
  await fill('#p-standard_cost', '1234.5')
  await fill('#p-mrp', '1250')
  await fill('#p-change-reason', 'New moulding cost')
  await click('button[type=submit]')
  await waitFor(`location.pathname === '/products/p2'`, 'saved')
  await goto('/products?q=MOCK-WC-2')
  await waitFor(`[...document.querySelectorAll('tbody tr')].some((r) => r.innerText.includes('MOCK-WC-2') && r.querySelector('td[data-col=cost]')?.innerText.trim() === '₹1,234.50' && r.querySelector('td[data-col=mrp]')?.innerText.trim() === '₹1,250.00')`, 'edited cost and MRP shown')
  // A drill-down list (Missing Information) has the same columns.
  await goto('/products?drill=pm.incomplete')
  await waitFor(`!!document.querySelector('[data-testid=drill-banner]') && !!document.querySelector('td[data-col=cost]') && !!document.querySelector('td[data-col=mrp]') && !!document.querySelector('td[data-col=hsn]') && !!document.querySelector('td[data-col=gst]')`, 'columns in a drill-down list')
})

await step('Product image links: thumbnails with preview and placeholder, detail and edit form, Excel import by EAN with field selection, PO and GRN thumbnails', async () => {
  const IMG_OK = 'https://img.smoke.example/basin.png'
  const IMG_NEW = 'https://img.smoke.example/basin-new.png'
  const IMG_BROKEN = 'https://img.smoke.example/broken.jpg'
  const [p1, p2, p3, p4] = products
  const saved = products.slice(0, 4).map((p) => ({ image_url: p.image_url, ean: p.ean }))
  const savedKey = ERP_SETTINGS.settings['product.import_match_key']
  Object.assign(p1, { image_url: IMG_OK, ean: '4006381333931' })
  Object.assign(p2, { image_url: IMG_BROKEN })
  Object.assign(p3, { ean: '9780201379624' })
  Object.assign(p4, { ean: '5901234123457' })
  const thumbIn = (sku) => `[...document.querySelectorAll('tbody tr')].find((tr) => tr.innerText.includes(${JSON.stringify(sku)}))?.querySelector('[data-testid=product-thumb]')`
  const loaded = (sel) => `(() => { const i = (${sel})?.querySelector('img'); return !!i && i.complete && i.naturalWidth > 0 })()`
  try {
    // 10. Product Master: thumbnail beside the name, larger preview on click, placeholder for a broken link and for no image.
    await goto('/products')
    await waitFor(loaded(thumbIn('MOCK-WC-1')), 'MOCK-WC-1 thumbnail loaded')
    assert(await evaluate(`(${thumbIn('MOCK-WC-1')}).querySelector('img').getAttribute('loading') === 'lazy' && getComputedStyle((${thumbIn('MOCK-WC-1')}).querySelector('img')).objectFit === 'contain'`), 'thumbnail not lazy / contain')
    await waitFor(`(${thumbIn('MOCK-WC-2')})?.dataset.state === 'broken' && !!(${thumbIn('MOCK-WC-2')}).querySelector('[data-testid=product-thumb-placeholder]')`, '9. broken link shows the placeholder')
    assert(await evaluate(`(${thumbIn('MOCK-CLAY')})?.dataset.state === 'none'`), 'no image: placeholder')
    await evaluate(`(${thumbIn('MOCK-WC-1')}).click()`)
    await waitFor(`document.querySelector('[data-testid=product-image-preview]')?.innerText.includes(${JSON.stringify(IMG_OK)})`, 'larger preview with the source link')
    await screenshot('161-product-image-preview')
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await sleep(300)

    // 11. Product detail: the image, its source, and upload / link actions.
    await goto('/products/p1')
    await waitFor(loaded(`document.querySelector('[data-testid=product-image-panel] [data-testid=product-thumb]')`), 'detail image loaded')
    assert(await evaluate(`document.querySelector('[data-testid=product-image-source]').innerText === 'From image link' && document.querySelector('[data-testid=product-image-link]').href === ${JSON.stringify(IMG_OK)}`), 'detail source')
    assert(await evaluate(bodyHasAll('Upload image', 'Change image link', 'Save a copy in ERP')), 'detail image actions missing')

    // 12. Edit form: shows the link with a live preview; an invalid link is explained; a new link is saved alone (no reason needed: images are not versioned).
    await goto('/products/p1/edit')
    await waitFor(`document.querySelector('#p-image_url')?.value === ${JSON.stringify(IMG_OK)}`, 'edit form shows the link')
    await waitFor(`document.querySelector('[data-draft-status]')?.dataset.draftStatus !== 'loading'`, 'draft check')
    await fill('#p-image_url', 'ftp://img.smoke.example/a.jpg')
    await waitFor(`document.querySelector('[data-testid=image-url-problem]')?.innerText.includes('http')`, 'invalid link explained')
    await fill('#p-image_url', IMG_NEW)
    await waitFor(`(() => { const i = document.querySelector('[data-testid=image-link-field] img'); return !!i && i.src === ${JSON.stringify(IMG_NEW)} })()`, 'live preview of the new link')
    const before = productPatches().length
    await click('button[type=submit]', 'Save changes')
    await waitFor(`location.pathname === '/products/p1'`, 'saved')
    const body = productPatches().at(-1).body
    assert(productPatches().length === before + 1 && JSON.stringify(Object.keys(body)) === '["image_url"]' && body.image_url === IMG_NEW, JSON.stringify(body))

    // 1, 6, 7, 8. Import matched by EAN (ERP Settings): only the image link changes; blank keeps; invalid is reported; unticked keeps.
    ERP_SETTINGS.settings['product.import_match_key'] = 'EAN'
    const file = path.join(outDir, 'import-images.xlsx')
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['EAN Code', 'Product Image URL'], ['4006381333931', IMG_OK], ['9780201379624', ''], ['5901234123457', 'javascript:alert(1)']]), 'Products')
    writeFileSync(file, Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'array' })))
    await uploadImportFile(file)
    assert(await evaluate(`document.querySelector('#map-image_url')?.innerText.includes('Product Image URL')`), 'Image Link column not detected')
    await waitFor(`!!document.querySelector('[data-testid=modify-field][data-field=image_url]')`, 'Image Link under Fields to Modify')
    const writesBefore = writes().length
    await click('button', 'Validate')
    await waitFor(`!!document.querySelector('[data-testid=image-summary]')`, 'image preview')
    const statuses = await evaluate(`[...document.querySelectorAll('[data-testid=image-row]')].map((r) => r.dataset.status)`)
    assert(JSON.stringify(statuses) === '["changed","blank","invalid"]', JSON.stringify(statuses))
    const summary = await evaluate(`document.querySelector('[data-testid=image-summary]').innerText.replace(/\\s+/g, ' ')`)
    for (const t of ['Images to add', 'Images to update', 'Images unchanged', 'Invalid image links', 'Blank image links skipped']) assert(summary.toLowerCase().includes(t.toLowerCase()), `${t}: ${summary}`)
    assert(await evaluate(`document.querySelector('[data-testid=image-row][data-status=changed]').innerText.includes('4006381333931') && !!document.querySelector('[data-testid=image-row][data-status=changed] [data-testid=image-new] img')`), 'identifier / new image missing')
    assert(await evaluate(`document.querySelector('[data-testid=image-row][data-status=invalid]')?.innerText.includes('Invalid URL') && document.querySelector('[data-testid=image-row][data-status=invalid]').innerText.includes('http:// or https://')`), 'invalid link not reported')
    await screenshot('162-import-image-links')
    assert(writes().length === writesBefore, 'validation wrote data')
    await click('button', 'Add 0 new and update 1')
    await waitFor(`document.querySelector('[data-testid=import-confirm-images]')?.innerText.includes('to update: 1')`, 'confirmation shows image counts')
    await click('[role=alertdialog] button', 'Save changes')
    await waitFor(bodyHas('Import finished'), 'import done')
    const made = writes().slice(writesBefore)
    assert(!made.some((r) => r.method === 'POST'), 'a product was created')
    const patch = made.filter((r) => r.method === 'PATCH')
    assert(patch.length === 1 && JSON.stringify(Object.keys(patch[0].body).sort()) === '["change_reason","image_url"]' && patch[0].body.image_url === IMG_OK && patch[0].query.includes('id=eq.p1'),
      'only the image link of p1 is updated: ' + JSON.stringify(patch.map((p) => [p.query, p.body])))
    // Image Link unticked: the stored image is kept.
    await uploadImportFile(file)
    await waitFor(`!!document.querySelector('[data-testid=modify-field][data-field=image_url]')`, 'fields to modify')
    await click('[data-testid=modify-field][data-field=image_url]')
    await click('button', 'Validate')
    await waitFor(`!!document.querySelector('[data-testid=image-summary]')`, 'image preview')
    assert(JSON.stringify(await evaluate(`[...document.querySelectorAll('[data-testid=image-row]')].map((r) => r.dataset.status)`)) === '["not-selected","not-selected","not-selected"]', 'unticked Image Link still changes images')

    // PO and GRN line items show the product thumbnail.
    await goto('/purchase-orders/po3')
    await waitFor(`!!document.querySelector('main [data-testid=product-thumb]')`, 'PO line thumbnail')
    await goto('/goods-receipts/gr1')
    await waitFor(`!!document.querySelector('main [data-testid=product-thumb]')`, 'GRN line thumbnail')
  } finally {
    products.slice(0, 4).forEach((p, i) => Object.assign(p, saved[i]))
    ERP_SETTINGS.settings['product.import_match_key'] = savedKey
  }
})

await step('Units of measurement: MTR, LTR and ROL are selectable, saved as codes, editable and shown after a reload', async () => {
  const pickUnit = async (label) => {
    await click('#p-unit')
    await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.trim() === ${JSON.stringify(label)})`, `${label} option`)
    await evaluate(`[...document.querySelectorAll('[role=option]')].find((o) => o.innerText.trim() === ${JSON.stringify(label)}).click()`)
    await waitFor(`document.querySelector('#p-unit').innerText.includes(${JSON.stringify(label)})`, `${label} selected`)
  }
  await goto('/products/new')
  await waitFor(`!!document.querySelector('#p-unit')`, 'form')
  await click('#p-unit')
  await waitFor(`document.querySelectorAll('[role=option]').length > 0`, 'unit options')
  const options = await evaluate(`[...document.querySelectorAll('[role=option]')].map((o) => o.innerText.trim())`)
  for (const label of ['Pieces (PCS)', 'Numbers (NOS)', 'Kilograms (KGS)', 'Grams (GMS)', 'Metric Tonnes (MTS)', 'Metres (MTR)', 'Litres (LTR)', 'Rolls (ROL)', 'Boxes (BOX)',
    'Cartons (CTN)', 'Sets (SET)', 'Pairs (PRS)', 'Bundles (BDL)', 'Square Metres (SQM)', 'Cubic Metres (CBM)']) assert(options.includes(label), `${label} missing: ${options.join(' | ')}`)
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await sleep(300)
  const created = []
  for (const [name, label, code] of [['UOM Hose', 'Metres (MTR)', 'MTR'], ['UOM Oil', 'Litres (LTR)', 'LTR'], ['UOM Tape', 'Rolls (ROL)', 'ROL']]) {
    // The mock API does not number SKUs like the database does, so each test product has one.
    await goto('/products/new')
    await waitFor(`!!document.querySelector('#p-unit')`, 'form')
    await fill('#p-sku', `UOM-${code}`)
    await fill('#p-product_name', name)
    await click('#p-type')
    await click('[role=option]', 'Raw Material')
    await pickUnit(label)
    const before = writes().length
    await click('button[type=submit]', 'Save product')
    await waitFor(`${bodyHas(' saved')} || ${bodyHas('Select a unit of measurement.')}`, `${code} saved`)
    assert(!(await evaluate(bodyHas('Select a unit of measurement.'))), `${code}: "Select a unit of measurement." shown`)
    assert(writes().length === before + 1 && writes().at(-1).body.base_unit === code, `${code} payload: ${JSON.stringify(writes().at(-1)?.body?.base_unit)}`)
    created.push(products.find((p) => p.product_name === name))
  }
  const [hose, oil] = created
  for (const [p, label, code] of [[hose, 'Litres (LTR)', 'LTR'], [oil, 'Rolls (ROL)', 'ROL']]) {
    await goto(`/products/${p.id}/edit`)
    await waitFor(`!!document.querySelector('#p-change-reason') && document.querySelector('#p-unit').innerText.includes(${JSON.stringify(p.base_unit)})`, `edit form shows ${p.base_unit}`)
    await waitFor(`document.querySelector('[data-draft-status]')?.dataset.draftStatus !== 'loading'`, 'draft check')
    await pickUnit(label)
    await fill('#p-change-reason', 'Unit corrected')
    const before = productPatches().length
    await click('button[type=submit]', 'Save changes')
    await waitFor(`location.pathname === '/products/${p.id}'`, `${code} change saved`)
    const body = productPatches().at(-1).body
    assert(productPatches().length === before + 1 && body.base_unit === code, JSON.stringify(body))
    // Reload: the detail page and the edit form show the saved unit.
    await goto(`/products/${p.id}`)
    await waitFor(bodyHas(`${label.split(' (')[0]} (${code})`), `detail shows ${code}`)
    await goto(`/products/${p.id}/edit`)
    await waitFor(`!!document.querySelector('#p-unit') && document.querySelector('#p-unit').innerText.includes(${JSON.stringify(label)})`, `edit form shows ${code} after reload`)
  }
  await screenshot('160-product-unit-rol')
})

await step('Purchase cost intelligence: Product Master columns, history with filters and override, PO comparison with warning, settings', async () => {
  await signOut()
  await login('owner@test.invalid')
  await waitFor(`location.pathname !== '/login'`, 'owner signed in')
  const pcBackup = JSON.stringify({ current: PC_HISTORY.current, events: PC_EVENTS })
  try {
    await goto('/products')
    for (let i = 0; i < 60 && !(await evaluate(`!!document.querySelector('[data-col=last-cost] a[data-testid=last-cost]')`)); i++) await sleep(100)
    const heads = await evaluate(`[...document.querySelectorAll('thead th')].map((th) => th.innerText.trim().toLowerCase()).join('|')`)
    assert(heads.includes('cost|last purchase cost|last purchase date|cost change|mrp'), 'column order: ' + heads)
    const row = `[...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes('MOCK-WC-1'))`
    assert((await evaluate(`${row}.querySelector('[data-col=last-cost]').innerText`)).includes('₹920.00'), 'last purchase cost')
    assert((await evaluate(`${row}.querySelector('[data-col=last-date]').innerText`)) !== '—', 'last purchase date')
    const change = await evaluate(`${row}.querySelector('[data-col=cost-change]').innerText`)
    assert(change.includes('+8.24%') && change.includes('+₹70.00') && (await evaluate(`!!${row}.querySelector('[data-col=cost-change] [data-trend=up]')`)), change)
    assert(!(await evaluate(`${row}.querySelector('[data-col=cost]').innerText.includes('920')`)), 'COST column must not be the last purchase cost')
    assert((await evaluate(`${row}.querySelector('[data-col=cost]').innerText`)).includes('₹850.00')
      && (await evaluate(`${row}.querySelector('[data-col=cost]').dataset.source`)) === 'PURCHASE'
      && (await evaluate(`${row}.querySelector('[data-col=cost]').title`)).includes('Second-most-recent purchase receipt GRN-000009'), 'Cost = second-most-recent receipt')
    await evaluate(`${row}.querySelector('[data-col=last-cost] a').click()`)
    await waitFor(`location.pathname === '/products/p1' && location.search.includes('tab=purchase-cost') && !!document.querySelector('[data-testid=pc-event]')`, 'history tab')
    const tile = await evaluate(`document.querySelector('[data-testid=pc-current]').innerText`)
    assert(tile.includes('₹920.00') && tile.includes('+8.24%') && tile.includes('Morbi Tiles LLP'), tile)
    for (const text of ['Average Inventory Cost', 'Last Purchase Cost', 'Standard Manufacturing Cost', 'Fallback Cost (fewer than two receipts)', 'Selling Price', 'Purchase cost trend', 'Price history', 'GRN-000010', 'PO-000003']) {
      assert(await evaluate(bodyHas(text)), `missing "${text}"`)
    }
    assert(await evaluate(`!!document.querySelector('[data-testid=pc-chart] svg')`), 'trend chart')
    const cols = await evaluate(`[...document.querySelectorAll('[data-testid=purchase-cost-history] th')].map((th) => th.innerText.toLowerCase()).join('|')`)
    for (const c of ['date', 'supplier', 'po number', 'grn number', 'previous cost', 'new cost', 'difference', '% change', 'accepted qty', 'user', 'status']) assert(cols.includes(c), `column ${c}: ${cols}`)
    const count = () => evaluate(`document.querySelectorAll('[data-testid=pc-event]').length`)
    assert((await count()) === 3, 'events listed')
    assert(await evaluate(bodyHas('Reversal')) && await evaluate(bodyHas('not applied')), 'reversal status')
    // Filters: increase only, supplier, date range.
    await choose('#pc-change', 'Increases only')
    await waitFor(`document.querySelectorAll('[data-testid=pc-event]').length === 1 && document.querySelector('[data-testid=pc-event]').dataset.change === 'INCREASE'`, 'increase filter')
    await choose('#pc-change', 'Decreases only')
    await waitFor(`!!document.querySelector('[data-testid=pc-empty]')`, 'no decreases')
    await choose('#pc-change', 'Increases and decreases')
    await choose('#pc-supplier', 'Morbi Tiles LLP')
    await waitFor(`document.querySelectorAll('[data-testid=pc-event]').length === 1`, 'supplier filter')
    await click('button', 'Clear filters')
    await fill('#pc-from', TODAY)
    await waitFor(`document.querySelectorAll('[data-testid=pc-event]').length === 2`, 'date filter')
    await click('button', 'Clear filters')
    await screenshot('purchase-cost-history')
    // Exceptional override (authorised user).
    await click('[data-testid=pc-override-open]')
    await fill('#pc-ov-cost', '950')
    await fill('#pc-ov-reason', 'Supplier credit note agreed')
    await click('[data-testid=pc-override] button', 'Save override')
    await waitFor(bodyHas('Last Purchase Cost overridden'), 'override saved')
    const ov = rpcCalls('product_purchase_cost_override').at(-1).body
    assert(ov.p_product_id === 'p1' && ov.p_cost === 950 && ov.p_reason === 'Supplier credit note agreed', JSON.stringify(ov))
    await waitFor(`document.querySelector('[data-testid=pc-current]').innerText.includes('₹950.00')`, 'override shown')
    await click('[data-testid=product-tab-overview]')
    await waitFor(bodyHas('Basic Information'), 'overview tab')
    // PO line: last cost and this supplier's previous price against the net PO price; significant change warned.
    Object.assign(PC_HISTORY.current, JSON.parse(pcBackup).current)
    await goto('/purchase-orders/po1/edit')
    await waitFor(`document.querySelector('[data-testid=po-cost-compare]')?.innerText.includes('₹920.00') && !!document.querySelector('[data-testid=po-supplier-price]')`, 'PO cost comparison')
    const cmp = await evaluate(`document.querySelector('[data-testid=po-cost-compare]').innerText`)
    assert(cmp.includes('₹900.00') && cmp.includes('−₹20.00') && cmp.includes('−2.17%') && cmp.includes('Price decrease') && cmp.includes('₹870.00'), cmp)
    assert((await evaluate(`document.querySelector('[data-testid=po-cost-compare]').dataset.warning`)) === 'false', 'a 2% change is not significant')
    await fill(`[id$="-price"]`, '1200')
    await waitFor(`document.querySelector('[data-testid=po-cost-compare]').dataset.trend === 'up' && !!document.querySelector('[data-testid=po-cost-warning]')`, 'significant increase warned (1080 vs 920)')
    assert((await evaluate(`document.querySelector('[data-testid=po-cost-warning]').innerText`)).includes('17.39%'), 'warning text')
    // Approved PO: comparison only.
    await goto('/purchase-orders/po3')
    await waitFor(`!!document.querySelector('[data-testid=po-line-last-cost]')`, 'approved PO comparison')
    assert((await evaluate(`document.querySelector('[data-testid=po-line-last-cost]').innerText`)).includes('₹920'), 'approved PO line vs last cost')
    // Settings.
    await goto('/admin/erp-settings?tab=products')
    await waitFor(`!!document.querySelector('[data-testid=purchase-cost-settings] #es-pc-zero')`, 'purchase cost settings')
    assert(await evaluate(bodyHas('GRN posting')) && await evaluate(bodyHas('always kept')), 'fixed trigger and history shown')
    await click('[data-testid=es-pc-dec]')
    await fill('#es-pc-threshold', '15')
    await choose('#es-pc-zero', 'Use zero only when the product has no cost yet')
    await choose('#es-pc-override', 'Users who can manage ERP settings')
    await click('button', 'Save settings')
    await waitFor(bodyHas('Settings saved and recorded in the audit log.'), 'saved')
    const s = rpcCalls('erp_settings_save').at(-1).body.p_settings
    assert(s['product.purchase_cost_decrease_alerts'] === false && s['product.purchase_cost_alert_percent'] === 15 && s['product.purchase_cost_zero_policy'] === 'INITIAL_ONLY'
      && s['product.purchase_cost_override_permission'] === 'settings.manage', JSON.stringify(s))
  } finally {
    const b = JSON.parse(pcBackup)
    Object.assign(PC_HISTORY.current, b.current)
    PC_EVENTS.splice(0, PC_EVENTS.length, ...b.events)
    Object.assign(ERP_SETTINGS.settings, { 'product.purchase_cost_decrease_alerts': true, 'product.purchase_cost_alert_percent': 10, 'product.purchase_cost_zero_policy': 'IGNORE',
      'product.purchase_cost_override_permission': 'purchase_exception.approve' })
    await signOut()
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'manager signed in again')
  }
})

await step('Missing Information bulk delete: Super Admin selects products, sees duplicates, confirms with DELETE PRODUCTS; used products are protected', async () => {
  // Two never-used products without HSN / GST (so they are in Missing Information); one has the same name as MOCK-WC-1.
  products.push(product(901, { id: 'dup1', sku: 'DUP-1', product_name: 'Mock Closet 1', hsn_code: null, gst_rate: null, category_id: null }),
    product(902, { id: 'dup2', sku: 'DUP-2', product_name: 'Unused duplicate seat', hsn_code: null, gst_rate: null, category_id: null }))
  await signOut()
  await login('owner@test.invalid')
  await waitFor(`location.pathname !== '/login'`, 'owner signed in')
  await goto('/products?drill=pm.incomplete')
  await waitFor(`document.querySelectorAll('[data-testid=select-row]').length > 0 && !!document.querySelector('[data-testid=bulk-bar]')`, 'checkboxes in Missing Information')
  const count = () => evaluate(`document.querySelector('[data-testid=bulk-count]').innerText`)
  const deleteDisabled = () => evaluate(`document.querySelector('[data-testid=bulk-delete]').disabled`)
  assert((await count()) === '0 products selected' && (await deleteDisabled()), 'Delete Selected must be disabled with nothing selected')
  // Duplicate indicator: same name as MOCK-WC-1.
  await waitFor(`[...document.querySelectorAll('tbody tr')].some((r) => r.innerText.includes('DUP-1') && r.querySelector('[data-testid=dup-hints]')?.innerText.includes('Same name as MOCK-WC-1'))`, 'duplicate indicator')
  const rowsOnPage = await evaluate(`document.querySelectorAll('[data-testid=select-row]').length`)
  // 3. Select All, then 4. deselect one.
  await click('[data-testid=select-all]')
  await waitFor(`document.querySelector('[data-testid=bulk-count]').innerText === '${rowsOnPage} ${rowsOnPage === 1 ? 'product' : 'products'} selected'`, 'all rows on the page selected')
  await click('[data-testid=select-row][data-sku="DUP-2"]')
  await waitFor(`document.querySelector('[data-testid=bulk-count]').innerText.startsWith('${rowsOnPage - 1} ') && document.querySelector('[data-testid=select-all]').dataset.state === 'indeterminate'`, 'one deselected after Select All')
  await click('button', 'Clear selection')
  await waitFor(`document.querySelector('[data-testid=bulk-count]').innerText === '0 products selected'`, 'selection cleared')
  // Whole filtered result set.
  const total = await evaluate(`Number(document.querySelector('[data-testid=drill-banner]').innerText.match(/(\\d+)/)?.[1] ?? 0)`)
  if (await evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.includes('matching'))`)) {
    await click('button', 'matching')
    await waitFor(`document.querySelector('[data-testid=bulk-count]').innerText.startsWith('${rowsOnPage} ') || / selected$/.test(document.querySelector('[data-testid=bulk-count]').innerText) && !document.querySelector('[data-testid=bulk-count]').innerText.startsWith('0 ')`, 'all matching selected')
    await click('button', 'Clear selection')
  }
  assert(total >= 0, 'banner count')
  // 2./5. Two never-used products and one with stock.
  for (const sku of ['DUP-1', 'DUP-2', 'MOCK-CLAY']) await click(`[data-testid=select-row][data-sku="${sku}"]`)
  await waitFor(`document.querySelector('[data-testid=bulk-count]').innerText === '3 products selected'`, '3 selected')
  await click('[data-testid=bulk-delete]')
  await waitFor(`!!document.querySelector('[data-testid=bulk-delete-counts]')`, 'confirmation with the dependency check')
  assert(await evaluate(bodyHas('You are about to permanently delete 3 selected products. Products linked to transactions will be protected. This operation cannot be undone.')), 'confirmation message')
  const counts = await evaluate(`document.querySelector('[data-testid=bulk-delete-counts]').innerText`)
  assert(counts.includes('2 will be permanently deleted') && counts.includes('1 protected'), counts)
  const clay = await evaluate(`document.querySelector('[data-testid=bulk-delete-dialog] tr[data-sku="MOCK-CLAY"]').innerText`)
  assert(clay.includes('Protected') && clay.includes('Stock ledger entries (3)') && clay.includes('Mock ceramic body'), clay)
  assert(await evaluate(`[...document.querySelectorAll('[data-testid=bulk-delete-dialog] th')].map((th) => th.innerText.toLowerCase()).join('|').includes('cost|mrp|hsn|gst') && !document.querySelector('[data-testid=bulk-delete-dialog]').innerText.toLowerCase().includes('mfg')`), 'cost, MRP, HSN and GST columns')
  const runBtn = `[...document.querySelectorAll('[data-testid=bulk-delete-dialog] button')].find((b) => b.innerText.includes('Delete 2 products'))`
  assert(await evaluate(`${runBtn}.disabled`), 'enabled before the phrase is typed')
  await fill('#bd-phrase', 'delete products')
  await waitFor(bodyHas('The phrase does not match.'), 'wrong phrase flagged')
  assert(await evaluate(`${runBtn}.disabled`), 'a wrong phrase enables deletion')
  const before = requests.filter((r) => r.path === '/rest/v1/rpc/product_bulk_delete').length
  await fill('#bd-phrase', 'DELETE PRODUCTS')
  await waitFor(`!${runBtn}.disabled`, 'enabled with the phrase')
  await screenshot('bulk-delete-confirm')
  await evaluate(`${runBtn}.click()`)
  await waitFor(`!!document.querySelector('[data-testid=bulk-delete-result]')`, 'results')
  const call = requests.filter((r) => r.path === '/rest/v1/rpc/product_bulk_delete')
  assert(call.length === before + 1, 'not called once')
  const b = call.at(-1).body
  assert(b.p_ids.length === 3 && b.p_confirmation === 'DELETE PRODUCTS' && b.p_reason === 'Duplicate product' && b.p_archive_blocked === false && b.p_request_id, JSON.stringify(b))
  const result = await evaluate(`document.querySelector('[data-testid=bulk-delete-result]').innerText`)
  assert(/Successfully deleted\s*2/.test(result) && /Blocked \(transactions\)\s*1/.test(result) && result.includes('DUP-1') && result.includes('Stock ledger entries'), result)
  assert(await evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.includes('Download failed-record report'))`), 'failed-record report')
  await screenshot('bulk-delete-result')
  await click('[data-testid=bulk-delete-dialog] button', 'Close')
  // 10. The list reloads with the same filter; deleted products are gone; the protected one stays selected.
  await waitFor(`!document.querySelector('[data-testid=bulk-delete-dialog]') && ![...document.querySelectorAll('tbody tr')].some((r) => r.innerText.includes('DUP-1'))`, 'list refreshed')
  assert(await evaluate(`location.search.includes('drill=pm.incomplete') && !!document.querySelector('[data-testid=drill-banner]')`), 'filter lost after deletion')
  assert((await count()) === '1 product selected', 'selection after deletion: ' + (await count()))
  assert(!products.some((p) => p.id === 'dup1' || p.id === 'dup2') && products.some((p) => p.id === 'p3'), 'mock data')
  // Other users: no selection or delete.
  await signOut()
  await login('manager@test.invalid')
  await waitFor(`location.pathname !== '/login'`, 'manager signed in')
  await goto('/products?drill=pm.incomplete')
  await waitFor(`!!document.querySelector('[data-testid=drill-banner]') && document.querySelectorAll('tbody tr').length > 0`, 'list for the manager')
  assert(!(await evaluate(`!!document.querySelector('[data-testid=select-row]') || !!document.querySelector('[data-testid=bulk-bar]')`)), 'a non-Super Admin sees bulk delete')
})

await step('List cards 3: Purchase Orders, Goods Received, Ledger and the stock card: each card opens its records with the same rule', async () => {
  await goto('/purchase-orders')
  await waitFor(`[...document.querySelectorAll('a[data-drill=kpi]')].length === 10`, 'ten PO cards are links')
  await click('a[data-drill=kpi]', 'Draft')
  await waitFor(`location.pathname === '/drilldown/purchase.status' && new URLSearchParams(location.search).get('seg') === 'DRAFT'`, 'drafts')
  await waitFor(`!!document.querySelector('[data-testid=drill-count]') && ${bodyHas('Purchase Orders')}`, 'records page, back to Purchase Orders')
  assert(lastQuery('/rest/v1/purchase_order_list_excl_gst').includes('status=eq.DRAFT'), lastQuery('/rest/v1/purchase_order_list_excl_gst'))
  assert(await evaluate(`[...document.querySelectorAll('nav[aria-label=Breadcrumb] a')].some((a) => a.innerText === 'Purchase Orders' && a.getAttribute('href').startsWith('/purchase-orders'))`), 'breadcrumb')

  await goto('/goods-receipts')
  await waitFor(`[...document.querySelectorAll('a[data-drill=kpi]')].length === 6`, 'six GRN cards')
  await click('[role=group][aria-label="Receipt type"] button', 'Unlinked')
  await waitFor(`new URLSearchParams(location.search).get('view') === 'DIRECT'`, 'tab in the address')
  await click('a[data-drill=kpi]', 'Reversed')
  await waitFor(`location.pathname === '/drilldown/grn.reversed'`, 'reversed receipts')
  assert(lastQuery('/rest/v1/goods_receipt_list_v2').includes('status=eq.REVERSED'), lastQuery('/rest/v1/goods_receipt_list_v2'))
  await evaluate('history.back()')
  await waitFor(`location.pathname === '/goods-receipts' && ${pressed('Unlinked')}`, 'Back keeps the GRN tab')

  await goto('/ledger')
  await waitFor(`[...document.querySelectorAll('a[data-drill=kpi]')].length === 6`, 'six ledger cards')
  await click('a[data-drill=kpi]', 'Customers')
  await waitFor(`location.pathname === '/drilldown/ledger.page_customer' && !!document.querySelector('[data-testid=drill-count]')`, 'customers')
  assert(rpcCalls('ledger_parties_excl_gst').length > 0, 'parties not read from the ledger function')

  await goto('/inventory/stock/p1')
  await waitFor(`[...document.querySelectorAll('a[data-drill=kpi]')].length === 6`, 'six stock card figures')
  await click('a[data-drill=kpi]', 'Available')
  await waitFor(`location.pathname === '/drilldown/stock.product_available' && new URLSearchParams(location.search).get('seg') === 'p1'`, 'this product\'s lots')
  // The drill-down page sends its own query just after the address changes.
  const stockQueryOk = () => lastQuery('/rest/v1/inventory_stock_detail').includes('product_id=eq.p1') && lastQuery('/rest/v1/inventory_stock_detail').includes('available=neq.0')
  for (let t = Date.now(); !stockQueryOk() && Date.now() - t < 5000;) await sleep(100)
  assert(stockQueryOk(), lastQuery('/rest/v1/inventory_stock_detail'))
  assert(await evaluate(`[...document.querySelectorAll('nav[aria-label=Breadcrumb] a')].some((a) => a.getAttribute('href').startsWith('/inventory/stock/p1'))`), 'breadcrumb back to the stock card')
})

await step('List cards 4: department status tabs are kept in the address, so Back returns to the same tab', async () => {
  for (const [path, group, label, param, value] of [
    ['/production/orders', 'Order status', 'Completed', 'status', 'COMPLETED'],
    ['/sales/orders', 'Order status', 'Cancelled', 'tab', 'CANCELLED'],
    ['/billing/invoices', 'Invoice status', 'Overdue', 'tab', 'OVERDUE'],
    ['/inventory/reservations', 'Status', 'Released', 'status', 'RELEASED'],
    ['/production/boms', 'BOM status', 'Draft', 'status', 'DRAFT'],
  ]) {
    await goto(path)
    await waitFor(`!!document.querySelector('[role=group][aria-label="${group}"]')`, `${path} tabs`)
    await click(`[role=group][aria-label="${group}"] button`, label)
    await waitFor(`new URLSearchParams(location.search).get('${param}') === '${value}'`, `${path}: tab in the address`)
    await goto('/')
    await waitFor(bodyHas('Management Dashboard'), 'away')
    await evaluate('history.back()')
    await waitFor(`location.pathname === '${path}' && ${pressed(label)}`, `${path}: Back keeps the ${label} tab`)
  }
})

await step('Drill-down 6: records stay behind permissions; unknown figures are refused', async () => {
  await signOut()
  await login('viewer@test.invalid')
  await waitFor(`location.pathname !== '/login'`, 'viewer signed in')
  const before = requests.filter((r) => r.path === '/rpc/ledger_parties' || r.path === '/rest/v1/rpc/ledger_parties').length
  await goto('/drilldown/ledger.receivables')
  await waitFor(bodyHas("You don't have permission to view these records"), 'denied')
  assert(requests.filter((r) => r.path === '/rest/v1/rpc/ledger_parties').length === before, 'records requested without permission')
  await goto('/drilldown/not.a.figure')
  await waitFor(bodyHas('This dashboard figure does not exist'), 'unknown figure')
})

// ---------------------------------------------------------------------------
// Password reset with a 6-digit e-mail code (no magic link)
// ---------------------------------------------------------------------------
const recoverCalls = () => requests.filter((r) => r.path === '/auth/v1/recover')
const verifyCalls = () => requests.filter((r) => r.path === '/auth/v1/verify' && r.body?.type === 'recovery')
const passwordPuts = () => requests.filter((r) => r.path === '/auth/v1/user' && r.method === 'PUT')
const otpValues = () => evaluate(`[...document.querySelectorAll('[data-otp-index]')].map((i) => i.value).join(',')`)
const activeOtp = () => evaluate(`document.activeElement?.dataset?.otpIndex ?? null`)
async function typeKey(key) {
  const isChar = key.length === 1
  const vk = key === 'Backspace' ? 8 : isChar ? key.toUpperCase().charCodeAt(0) : 0
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key === 'Backspace' ? 'Backspace' : `Key${key}`, windowsVirtualKeyCode: vk, ...(isChar ? { text: key } : {}) })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: vk })
  await sleep(80)
}
const pasteInto = (selector, text) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)}); el.focus();
  const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)});
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
})()`)
const storedValues = () => evaluate(`JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })`)
const resendState = (enabled, label) => `[...document.querySelectorAll('[data-testid=otp-resend]')].some((b) => ${enabled ? '!b.disabled' : 'b.disabled'} && b.innerText.includes(${JSON.stringify(label)}))`

await step('Password reset 1: Forgot password asks for the e-mail and sends a 6-digit code (no link); unknown addresses get the same answer; repeated requests are refused by the server', async () => {
  await signOut()
  await click('a', 'Forgot password?')
  await waitFor(`location.pathname === '/forgot-password' && !!document.querySelector('#forgot-email')`, 'e-mail step')
  await fill('#forgot-email', 'not-an-email')
  await click('button[type=submit]', 'Send code')
  await waitFor(bodyHas('Enter a valid email address.'), 'e-mail validated')
  assert(recoverCalls().length === 0, 'request sent for an invalid address')
  await fill('#forgot-email', 'nobody@test.invalid')
  await click('button[type=submit]', 'Send code')
  await waitFor(`${bodyHasAll('Enter the 6-digit code', 'If an account exists for', 'nobody@test.invalid')} && document.querySelectorAll('[data-otp-index]').length === 6`, 'same answer for an unknown address')
  assert(recoverCalls().at(-1).body.email === 'nobody@test.invalid' && !recoverCalls().at(-1).query.includes('redirect_to'), 'a reset link (redirect) was requested: ' + JSON.stringify(recoverCalls().at(-1)))
  await click('button', 'Use a different email')
  await waitFor(`!!document.querySelector('#forgot-email')`, 'e-mail step again')
  await fill('#forgot-email', RESET_EMAIL)
  await click('button[type=submit]', 'Send code')
  await waitFor(`${bodyHas(RESET_EMAIL)} && document.querySelectorAll('[data-otp-index]').length === 6`, 'code step')
  await waitFor(resendState(false, 'Resend code in'), 'resend countdown')
  await screenshot('120-reset-code')
  // Asking again at once: the server refuses, and the page says how long to wait.
  await click('button', 'Use a different email')
  await waitFor(`!!document.querySelector('#forgot-email')`, 'e-mail step (third time)')
  await fill('#forgot-email', RESET_EMAIL)
  await click('button[type=submit]', 'Send code')
  await waitFor(`/Please wait \\d+ seconds before requesting another code/.test(document.body.innerText)`, 'server-side limit shown')
  assert(await evaluate(`!!document.querySelector('#forgot-email')`), 'left the e-mail step after a refused request')
  recovery.lastSent = 0 // a minute passes
  await click('button[type=submit]', 'Send code')
  await waitFor(`document.querySelectorAll('[data-otp-index]').length === 6`, 'code step again')
})

await step('Password reset 2: code boxes take digits only, move on, go back with Backspace and accept a pasted code; wrong and expired codes are refused clearly', async () => {
  await waitFor(`document.activeElement?.dataset?.otpIndex === '0'`, 'first box focused')
  await typeKey('9')
  assert((await activeOtp()) === '1', 'focus did not move on')
  await typeKey('a')
  assert((await otpValues()) === '9,,,,,', 'a letter was accepted: ' + (await otpValues()))
  await typeKey('8')
  assert((await otpValues()) === '9,8,,,,' && (await activeOtp()) === '2', 'second digit: ' + (await otpValues()))
  await typeKey('Backspace')
  assert((await otpValues()) === '9,,,,,' && (await activeOtp()) === '1', 'Backspace from an empty box: ' + (await otpValues()) + ' focus ' + (await activeOtp()))
  const before = verifyCalls().length
  await pasteInto('#otp-0', '000 000')
  await waitFor(bodyHas('That code is incorrect or has expired'), 'wrong code refused')
  assert(verifyCalls().length === before + 1 && verifyCalls().at(-1).body.token === '000000' && verifyCalls().at(-1).body.email === RESET_EMAIL, JSON.stringify(verifyCalls().at(-1)?.body))
  await waitFor(`document.activeElement?.dataset?.otpIndex === '0'`, 'boxes cleared and refocused')
  assert((await otpValues()) === ',,,,,', 'wrong code left in the boxes')
  recovery.expired = true
  await pasteInto('#otp-0', recovery.code)
  for (let i = 0; i < 50 && verifyCalls().length < before + 2; i++) await sleep(100)
  assert(verifyCalls().length === before + 2, 'expired code not sent once')
  await waitFor(`${bodyHas('That code is incorrect or has expired')} && !document.querySelector('[data-otp-index]').disabled && document.querySelector('[data-otp-index]').value === ''`, 'expired code refused')
  recovery.expired = false
  const stored = await storedValues()
  assert(!stored.includes(recovery.code) && !stored.includes('000000'), 'a code was stored in the browser')
  await screenshot('121-reset-wrong-code')
})

await step('Password reset 3: a refresh keeps the code screen and countdown; Resend sends a new code after 60 s and the earlier code stops working', async () => {
  await goto('/forgot-password')
  await waitFor(`${bodyHas(RESET_EMAIL)} && ${resendState(false, 'Resend code in')}`, 'after refresh')
  const old = recovery.code
  // A minute passes (browser and server).
  await evaluate(`(() => { const k = 'alton:password-recovery:request:v1'; const v = JSON.parse(sessionStorage.getItem(k)); v.sentAt -= 61000; sessionStorage.setItem(k, JSON.stringify(v)) })()`)
  recovery.lastSent = 0
  await goto('/forgot-password')
  await waitFor(`[...document.querySelectorAll('[data-testid=otp-resend]')].some((b) => !b.disabled && b.innerText.trim() === 'Resend code')`, 'resend enabled')
  const sends = recoverCalls().length
  await click('[data-testid=otp-resend]')
  await waitFor(`${bodyHas('A new code has been sent')} && ${resendState(false, 'Resend code in')}`, 'resent, countdown again')
  assert(recoverCalls().length === sends + 1 && recovery.code !== old, 'no new code')
  await pasteInto('#otp-0', old)
  await waitFor(bodyHas('That code is incorrect or has expired'), 'earlier code refused')
})

await step('Password reset 4: the right code opens the new-password step only; the recovery session cannot open the ERP, even after a refresh', async () => {
  await waitFor(`!document.querySelector('[data-otp-index]').disabled`, 'boxes ready')
  const code = recovery.code
  const puts = passwordPuts().length
  await pasteInto('#otp-0', code)
  await waitFor(`${bodyHasAll('Choose a new password', 'Code verified for', RESET_EMAIL)} && !!document.querySelector('#new-password')`, 'password step')
  assert(passwordPuts().length === puts, 'password changed before the new password was entered')
  await screenshot('122-reset-new-password')
  await goto('/')
  await waitFor(`location.pathname === '/forgot-password' && ${bodyHas('Choose a new password')}`, 'ERP closed during recovery')
  await goto('/products')
  await waitFor(`location.pathname === '/forgot-password' && ${bodyHas('Choose a new password')}`, 'ERP pages closed during recovery')
  assert(!(await storedValues()).includes(code), 'the code was stored')
})

await step('Password reset 5: password strength and confirmation are checked before anything is sent; then the password is updated, every session ends and sign-in opens', async () => {
  const puts = passwordPuts().length
  await fill('#new-password', 'short1')
  await fill('#confirm-password', 'short1')
  await click('button[type=submit]', 'Update password')
  await waitFor(bodyHas('Use at least 8 characters.'), 'too short')
  await fill('#new-password', 'onlyletters')
  await fill('#confirm-password', 'onlyletters')
  await click('button[type=submit]', 'Update password')
  await waitFor(bodyHas('Use a mix of letters and numbers.'), 'too weak')
  await fill('#new-password', 'Glaze-2026')
  await fill('#confirm-password', 'Glaze-2027')
  await click('button[type=submit]', 'Update password')
  await waitFor(bodyHas('The passwords do not match.'), 'mismatch')
  assert(passwordPuts().length === puts, 'password sent before it was valid')
  await fill('#confirm-password', 'Glaze-2026')
  const logouts = () => requests.filter((r) => r.path === '/auth/v1/logout')
  const before = logouts().length
  await click('button[type=submit]', 'Update password')
  await waitFor(bodyHasAll('Password updated', 'signed out on every device'), 'success')
  assert(passwordPuts().length === puts + 1 && passwordPuts().at(-1).body.password === 'Glaze-2026', 'password not updated through Supabase Auth')
  assert(logouts().length === before + 1 && logouts().at(-1).query.includes('scope=global'), 'other sessions not ended: ' + JSON.stringify(logouts().at(-1)))
  await screenshot('123-reset-done')
  await waitFor(`location.pathname === '/login' && ${bodyHas('Your password has been updated. Sign in with your new password.')}`, 'redirected to sign in')
  const stored = await storedValues()
  assert(!stored.includes('alton:password-recovery') && !stored.includes('Glaze-2026'), 'recovery state left in the browser: ' + stored.slice(0, 300))
})

await step('Password reset 6: the old password no longer works, the new one signs in; old reset links never sign in', async () => {
  await login(RESET_EMAIL, 'correct-horse')
  await waitFor(bodyHas('Incorrect email or password.'), 'old password refused')
  await login(RESET_EMAIL, 'Glaze-2026')
  await waitFor(`location.pathname === '/' && ${bodyHas('Management Dashboard')}`, 'signed in with the new password')
  await signOut()
  await goto('/reset-password?code=old-link-code')
  await waitFor(`${bodyHasAll('Reset links are no longer used', '6-digit code')} && location.search === ''`, 'old link refused, address cleaned')
  await screenshot('124-reset-old-link')
  await goto('/reset-password')
  await waitFor(`location.pathname === '/forgot-password'`, 'plain /reset-password goes to the code flow')
})

await step('Password reset 7: on a phone the six boxes fit without horizontal scrolling; cancelling a verified reset keeps the password; normal sign-in still works', async () => {
  recovery.lastSent = 0
  await setViewport(360, 740)
  await sleep(300)
  await goto('/forgot-password')
  await waitFor(`!!document.querySelector('#forgot-email')`, 'e-mail step')
  await fill('#forgot-email', RESET_EMAIL)
  await click('button[type=submit]', 'Send code')
  await waitFor(`document.querySelectorAll('[data-otp-index]').length === 6`, 'code step')
  assert(await noHorizontalScroll(), 'code screen scrolls horizontally on a phone')
  assert(await evaluate(`[...document.querySelectorAll('[data-otp-index]')].every((i) => i.getBoundingClientRect().width >= 36 && i.getBoundingClientRect().right <= window.innerWidth)`), 'boxes too small or off screen')
  await screenshot('125-reset-code-mobile')
  await pasteInto('#otp-0', recovery.code)
  await waitFor(`!!document.querySelector('#new-password')`, 'password step')
  const puts = passwordPuts().length
  await click('button', 'Cancel and keep the old password')
  await waitFor(`location.pathname === '/login'`, 'cancelled')
  assert(passwordPuts().length === puts, 'password changed on cancel')
  await cdp('Emulation.clearDeviceMetricsOverride')
  await sleep(300)
  await login(RESET_EMAIL, 'Glaze-2026')
  await waitFor(`location.pathname === '/'`, 'password unchanged after cancel')
  await signOut()
  await login('manager@test.invalid')
  await waitFor(`location.pathname === '/'`, 'normal sign-in still works')
})

await step('Support Centre: navigation, overview, inbox (honest channel status, log a call, notes, restricted recording), tickets (validation, create, detail), customers, channel pages, settings, reports, workspace; denied without support access', async () => {
  Object.assign(tables, {
    support_agents: [{ id: 'sag1', company_id: COMPANY_ID, user_id: MANAGER_ID, display_name: 'Smoke Agent', department: 'Customer care', presence: 'AVAILABLE', is_active: true, max_open_conversations: 25 }],
    support_tags: [{ id: 'stag1', company_id: COMPANY_ID, name: 'Damage', color: 'danger' }],
    support_sla_policies: [{ id: 'ssla1', company_id: COMPANY_ID, name: 'Urgent', priority: 'URGENT', first_response_minutes: 15, resolution_minutes: 240, is_active: true }],
    support_channel_accounts: [{ id: 'sca1', company_id: COMPANY_ID, channel: 'WHATSAPP', display_name: 'Alton WhatsApp', identifier: '+91 90000 00000', provider: 'WhatsApp Cloud API',
      credentials_ref: 'WHATSAPP_CLOUD_TOKEN', status: 'SETUP_REQUIRED', status_detail: null, last_checked_at: null, connected_at: null, is_active: true }],
    support_integration_events: [{ id: 'sie1', company_id: COMPANY_ID, channel_account_id: 'sca1', event_type: 'ACCOUNT_CREATED', status: 'SETUP_REQUIRED', message: 'Account created from the app', created_at: NOW }],
    support_automation_rules: [{ id: 'sar1', company_id: COMPANY_ID, name: 'Breakage is urgent', trigger: 'TICKET_CREATED', conditions: { subject_contains: 'cracked' }, actions: { set_priority: 'URGENT' },
      run_order: 100, is_active: true, run_count: 3, last_run_at: NOW }],
    support_kb_articles: [{ id: 'skb1', company_id: COMPANY_ID, title: 'Replacing a damaged basin', body: 'Ask for photos, then raise a replacement.', category: 'Damage', tags: ['damage'], status: 'PUBLISHED', updated_at: NOW }],
  })
  const SUPPORT_PERMS = ['support.view', 'support.manage_tickets', 'support.assign', 'support.reply', 'support.manage_integrations', 'support.view_reports', 'support.manage_settings']
  USERS['manager@test.invalid'].permissions.push(...SUPPORT_PERMS)
  try {
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')

    // Navigation: the new section with its eleven pages.
    await goto('/support/overview')
    await waitFor(bodyHasAll('Support Overview', 'Total tickets', 'Open tickets', 'Unassigned tickets', 'Pending customer responses', 'Resolved tickets', 'Overdue SLA tickets',
      'Today’s incoming calls', 'Missed calls', 'WhatsApp conversations', 'Incoming emails', 'Average first response', 'Average resolution time', 'Customer satisfaction'), 'overview figures')
    const links = await evaluate(`[...document.querySelectorAll('aside a[href^="/support/"]')].map((a) => a.getAttribute('href'))`)
    // Unified Inbox and Support Automation keep their routes but are not in the sidebar.
    assert(links.join() === '/support/overview,/support/tickets,/support/customers,/support/calls,/support/whatsapp,/support/emails,/support/knowledge-base,/support/reports,/support/settings', `support links: ${links}`)
    await waitFor(bodyHasAll('Tickets by channel', 'Ticket status', 'Daily ticket volume', 'Agent performance', 'SLA compliance', 'Resolution time'), 'overview charts')
    // Channel status exactly as the server reports it: nothing shown as Connected.
    assert(await evaluate(`document.querySelector('[data-testid=channel-WHATSAPP]').dataset.status === 'SETUP_REQUIRED' && document.querySelector('[data-testid=channel-PHONE]').dataset.status === 'NOT_CONNECTED'`), 'channel status')
    assert(!(await evaluate(`[...document.querySelectorAll('[data-testid=channel-status] [data-status]')].some((e) => e.innerText.trim() === 'Connected')`)), 'a channel is shown as connected')
    for (const label of ['Today', 'Yesterday', 'This Week', 'This Month']) await click('[aria-label="Date range"] button', label)
    for (let i = 0; i < 30 && rpcCalls('support_overview').at(-1)?.body.p_from !== `${TODAY.slice(0, 7)}-01`; i++) await sleep(100)
    await screenshot('220-support-overview')

    // Inbox: list, conversation, reply blocked (not connected), log activity, internal note, restricted recording.
    await goto('/support/inbox')
    await waitFor(`!!document.querySelector('[data-testid=conversation-sc1]')`, 'inbox list')
    assert(await evaluate(bodyHasAll('All', 'Phone', 'WhatsApp', 'Email', 'Unassigned', 'My conversations', 'Open', 'Pending', 'Resolved')), 'inbox filters')
    await click('[aria-label="Inbox filter"] button', 'Unassigned')
    for (let i = 0; i < 30 && rpcCalls('support_inbox').at(-1)?.body.p_view !== 'UNASSIGNED'; i++) await sleep(100)
    assert(rpcCalls('support_inbox').at(-1).body.p_view === 'UNASSIGNED', 'filter sent to the server')
    await click('[aria-label="Inbox filter"] button', 'All')
    await fill('input[aria-label="Search conversations"]', 'cracked')
    for (let i = 0; i < 30 && rpcCalls('support_inbox').at(-1)?.body.p_search !== 'cracked'; i++) await sleep(100)
    assert(rpcCalls('support_inbox').at(-1).body.p_search === 'cracked', 'search runs on the server')
    await click('[data-testid=conversation-sc1]')
    await waitFor(`!!document.querySelector('[data-testid=conversation-pane]') && !!document.querySelector('[data-testid=timeline]')`, 'conversation')
    assert(await evaluate(`document.querySelector('[data-testid=pane-channel-status]').dataset.status === 'SETUP_REQUIRED'`), 'pane channel status')
    // Opens on Log activity because WhatsApp cannot send yet; the Reply tab explains why.
    await click('[data-testid=composer] button', 'Reply')
    await waitFor(`document.querySelector('[data-testid=reply-blocked]')?.innerText.includes('setup required')`, 'reply blocked while not connected')
    assert(await evaluate(bodyHasAll('logged manually', 'Internal note', 'Call recording — restricted', 'ALT-SUP-000001', 'Ravi Kumar')), 'timeline and links')
    assert(rpcCalls('support_conversation_mark_read').length > 0, 'unread conversation marked read')
    await click('[data-testid=composer] button', 'Log activity')
    await fill('textarea[aria-label="Message"]', 'Told the customer a replacement is on the way')
    await click('[data-testid=composer-send]')
    for (let i = 0; i < 30 && !rpcCalls('support_message_add').length; i++) await sleep(100)
    assert(rpcCalls('support_message_add').at(-1).body.p.mode === 'LOG', 'logged, not sent')
    await click('[data-testid=composer] button', 'Internal note')
    await fill('textarea[aria-label="Internal note"]', 'Replacement booked')
    await click('[data-testid=composer-send]')
    for (let i = 0; i < 30 && !rpcCalls('support_note_add').length; i++) await sleep(100)
    assert(rpcCalls('support_note_add').at(-1).body.p_target === 'CONVERSATION', 'note added')
    await screenshot('221-support-inbox')

    // Ambiguous customer: both candidates offered, nothing merged.
    await fill('input[aria-label="Search conversations"]', '')
    await waitFor(`!!document.querySelector('[data-testid=conversation-sc2]')`, 'full list again')
    await click('[data-testid=conversation-sc2]')
    await waitFor(`document.querySelector('[data-testid=unlinked-customer]')?.innerText.includes('Several customers match')`, 'ambiguous match')
    // Log a conversation: validation, then the call.
    await click('[data-testid=log-conversation]')
    await waitFor(bodyHas('Log a conversation'), 'log dialog')
    await click('[role=dialog] button[type=submit]', 'Log conversation')
    await waitFor(bodyHas('Choose the customer, or enter their phone number or email address.'), 'log validation')
    await fill('#lg-phone', '+91 98765 43210')
    await click('[role=dialog] button[type=submit]', 'Log conversation')
    await waitFor(`document.querySelector('[data-testid=inbox-notice]')?.innerText.includes('2 customers share this phone')`, 'logged, ambiguous match explained')
    assert(rpcCalls('support_conversation_create').at(-1).body.p.call_status === 'ANSWERED', 'call logged')

    // Tickets: filters, validation, create, detail.
    await goto('/support/tickets')
    await waitFor(`!!document.querySelector('[data-testid=tickets-table]') && ${bodyHas('ALT-SUP-000001')}`, 'tickets')
    await choose('[aria-label="Statuses"]', 'Resolved')
    for (let i = 0; i < 30 && rpcCalls('support_ticket_list').at(-1)?.body.p.status !== 'RESOLVED'; i++) await sleep(100)
    assert(rpcCalls('support_ticket_list').at(-1).body.p.status === 'RESOLVED', 'status filter sent')
    await click('[data-testid=new-ticket]')
    await waitFor(bodyHas('New ticket'), 'ticket dialog')
    await click('[role=dialog] button[type=submit]', 'Create ticket')
    await waitFor(bodyHasAll('Enter a subject (at least 3 characters).', 'Choose the customer or enter their phone number or email address.'), 'ticket validation')
    await fill('#tk-subject', 'Tap leaking')
    await fill('#tk-email', 'anita@shah.example')
    await click('[role=dialog] button[type=submit]', 'Create ticket')
    await waitFor(`location.pathname === '/support/tickets/st9'`, 'opens the new ticket')
    await waitFor(bodyHasAll('ALT-SUP-000009', 'Work on this ticket', 'Activity history', 'Internal notes', 'Attachments'), 'ticket detail')
    await screenshot('222-support-ticket')

    // Customers and profile.
    await goto('/support/customers')
    await waitFor(`!!document.querySelector('[data-testid=customers-table]')`, 'customers')
    await goto('/support/customers/scu1')
    await waitFor(bodyHasAll('Contact details', 'ERP customer', 'Acme Ltd', 'Tickets', 'Calls', 'Sales orders', 'SO-000001'), 'customer profile')

    // Channel pages ask the server for their channel only.
    for (const [path, channel] of [['/support/calls?tab=conversations', 'PHONE'], ['/support/whatsapp', 'WHATSAPP'], ['/support/emails', 'EMAIL']]) {
      await goto(path)
      for (let i = 0; i < 30 && rpcCalls('support_inbox').at(-1)?.body.p_channel !== channel; i++) await sleep(100)
      assert(rpcCalls('support_inbox').at(-1).body.p_channel === channel, `${path} channel`)
    }

    // Settings: channel accounts show the server's status; the form has no status field.
    await goto('/support/settings?tab=channels')
    await waitFor(`!!document.querySelector('[data-testid=channel-accounts]') && ${bodyHas('Setup Required')}`, 'channel accounts')
    await click('button', 'Add channel account')
    await waitFor(bodyHas('Saving never connects the channel'), 'account dialog')
    assert(!(await evaluate(`[...document.querySelectorAll('[role=dialog] label')].some((l) => /status/i.test(l.innerText))`)), 'status editable')
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    for (const page of ['/support/knowledge-base', '/support/automation', '/support/reports', '/support/workspace']) {
      await goto(page)
      await waitFor(bodyHasAll(...({ '/support/knowledge-base': ['Replacing a damaged basin'], '/support/automation': ['Breakage is urgent', 'subject contains'],
        '/support/reports': ['Agent performance', 'Export Excel'], '/support/workspace': ['My conversations', 'My tickets', 'My activity'] })[page]), page)
    }
    await screenshot('223-support-workspace')
    // Phone width: no horizontal scroll on the inbox.
    await setViewport(390, 844)
    await goto('/support/inbox')
    await waitFor(`!!document.querySelector('[data-testid=inbox-list]')`, 'mobile inbox')
    assert(await noHorizontalScroll(), 'mobile inbox scrolls horizontally')
    await cdp('Emulation.clearDeviceMetricsOverride')
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !SUPPORT_PERMS.includes(x))
  }
  // A role without support access sees no section and is refused.
  await signOut().catch(() => {})
  await login('viewer@test.invalid')
  await waitFor(`location.pathname !== '/login'`, 'viewer signed in')
  await goto('/support/inbox')
  await waitFor(bodyHas('Access denied'), 'support refused without support.view')
  assert(!(await evaluate(`!!document.querySelector('aside a[href^="/support/"]')`)), 'support section shown without access')
})

await step('Support telephony (Acefone): call button shows Initiated (never Connected), one request per dialog, incoming-call panel, call log and detail, Phone settings without secret values', async () => {
  const PHONE_PERMS = ['support.view', 'support.manage_tickets', 'support.assign', 'support.reply', 'support.manage_integrations', 'support.view_reports', 'support.manage_settings']
  USERS['manager@test.invalid'].permissions.push(...PHONE_PERMS)
  const fnCalls = (action) => requests.filter((r) => r.path === '/functions/v1/acefone-click-to-call' && r.body?.action === action)
  try {
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')

    // Outgoing: the call button beside the customer's number.
    await goto('/support/customers/scu1')
    await waitFor(`!!document.querySelector('[data-testid=call-button]')`, 'call button on the profile')
    const before = fnCalls('call').length
    await click('[data-testid=call-button]', 'Call')
    await waitFor(`!!document.querySelector('[data-testid=place-call]') && ${bodyHas('Desk')}`, 'call dialog with the agent line')
    await evaluate(`(() => { const b = document.querySelector('[data-testid=place-call]'); b.click(); b.click(); b.click() })()`)
    await waitFor(`document.querySelector('[data-testid=call-progress] [data-status]')?.dataset.status === 'INITIATED'`, 'status Initiated after the request is accepted')
    await sleep(3500) // one poll of the call status
    assert(fnCalls('call').length - before === 1, `repeated clicks placed ${fnCalls('call').length - before} requests`)
    const req = fnCalls('call').at(-1).body
    assert(req.idempotency_key && req.line_id === 'pl1' && req.number === '+91 98765 43210' && req.customer_id === 'scu1', `call request: ${JSON.stringify(req)}`)
    assert(await evaluate(`document.querySelector('[data-testid=call-progress] [data-status]').dataset.status === 'INITIATED'`), 'status changed without a provider event')
    assert(!(await evaluate(`document.querySelector('[role=dialog]').innerText.includes('Connected')`)), 'Connected shown although only the request was accepted')
    await screenshot('230-support-call-initiated')
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })

    // Incoming: the panel shows the matched customer, open tickets and previous interactions.
    PHONE_LIVE = [{ id: 'call9', direction: 'INBOUND', status: 'RINGING', number: '+919876543210', started_at: NOW, conversation_id: 'sc1', agent_name: null,
      customer: { id: 'scu1', customer_code: 'SC-000001', display_name: 'Ravi Kumar', company_name: null }, candidates: 1,
      open_tickets: [{ id: 'st1', ticket_number: 'TKT-000001', subject: 'Cracked basin', status: 'OPEN' }], previous_calls: 2, previous_conversations: 3 },
      { id: 'call10', direction: 'INBOUND', status: 'RINGING', number: '+919811111111', started_at: NOW, conversation_id: 'sc2', agent_name: null, customer: null, candidates: 0,
        open_tickets: [], previous_calls: 0, previous_conversations: 0 }]
    await goto('/support/overview')
    await waitFor(`!!document.querySelector('[data-testid=incoming-call9]')`, 'incoming call panel')
    const panel = await evaluate(`document.querySelector('[data-testid=incoming-calls]').innerText`)
    for (const t of ['Ravi Kumar', 'SC-000001', 'TKT-000001', '3 conversation(s), 2 earlier call(s)', 'Unknown caller', 'No customer has this number.', 'New customer', 'New ticket'])
      assert(panel.includes(t), `incoming panel missing "${t}"`)
    await screenshot('231-support-incoming-call')
    PHONE_LIVE = []

    // Call log and detail.
    await goto('/support/calls')
    await waitFor(`!!document.querySelector('[data-testid=call-log]')`, 'call log')
    assert(await evaluate(bodyHasAll('Incoming', 'Outgoing', 'Missed', 'Completed', 'TKT-000001')), 'call log rows')
    await goto('/support/calls/call2')
    await waitFor(`!!document.querySelector('[data-testid=call-detail]')`, 'call detail')
    assert(await evaluate(bodyHasAll('Ring duration', 'Talk duration', 'Acefone reference (ref_id)', 'REF-1', 'TKT-000001', 'Ravi Kumar', 'Status history')), 'call detail fields')
    assert(await evaluate(`document.querySelector('[data-testid=call-recording]').innerText.includes('copied here only when recording retrieval is enabled')`), 'recording state')
    assert(!(await evaluate(`document.body.innerHTML.includes('recording_url') || document.body.innerHTML.includes('token=')`)), 'a recording link was shown')

    // Settings > Phone: secret status only, never a value; webhook URLs carry a placeholder.
    await goto('/support/settings?tab=phone')
    await waitFor(`!!document.querySelector('[data-testid=phone-settings]') && !!document.querySelector('[data-testid=secret-api_token]')`, 'phone settings')
    await waitFor(`document.querySelector('[data-testid=secret-api_token]').innerText.includes('Configured') && document.querySelector('[data-testid=secret-support_api_key]').innerText.includes('Not set')`, 'secret status')
    assert(await evaluate(bodyHasAll('Acefone / Servetel', 'Toll-free number', 'API base URL', 'Click-to-Call mode', 'Agent telephony settings', '0501234567', 'Last successful event', 'Last call-record sync', 'Test connection', 'Replace secret', 'Disconnect')), 'phone settings fields')
    assert(await evaluate(`[...document.querySelectorAll('[data-testid=webhook-urls] code')].every((c) => c.innerText.includes('token=<ACEFONE_WEBHOOK_SECRET>') && c.innerText.includes('account=sca-phone'))`), 'webhook URL placeholder')
    assert(!(await evaluate(`[...document.querySelectorAll('input')].some((i) => i.type === 'password' || /token|secret|key/i.test(i.id))`)), 'a secret input is on the page')
    await click('[data-testid=secret-api_token] button', 'Replace secret')
    await waitFor(bodyHas('npx supabase secrets set ACEFONE_API_TOKEN=<new value>'), 'replace instructions')
    await click('[role=dialog] button', 'Done')
    await click('button', 'Test connection')
    await waitFor(`document.querySelector('[data-testid=phone-notice]')?.innerText.includes('1 call record readable')`, 'test connection')
    await click('[data-testid=phone-events] button', 'Replay')
    await waitFor(`document.querySelector('[data-testid=phone-notice]')?.innerText.includes('Replayed: processed')`, 'replay')
    await screenshot('232-support-phone-settings')
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PHONE_PERMS.includes(x))
  }
  // Without integration access the Phone tab is absent.
  await signOut().catch(() => {})
  await login('viewer@test.invalid')
  await waitFor(`location.pathname !== '/login'`, 'viewer signed in')
  await goto('/support/settings?tab=phone')
  await sleep(800)
  assert(!(await evaluate(`!!document.querySelector('[data-testid=phone-settings]')`)), 'phone settings shown without access')
})

await step('Support email (Gmail): Settings > Email connect / status without secrets, error return, email thread with sanitised view and attachments, reply threading, Pending / Failed / Sent never faked, one send per dialog', async () => {
  const PERMS = ['support.view', 'support.manage_tickets', 'support.assign', 'support.reply', 'support.manage_integrations', 'support.view_reports', 'support.manage_settings']
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  const mailConv = supportConv('sc-mail', 'EMAIL', { subject: 'Cracked basin', customer_id: 'scu1', last_message_preview: 'The basin arrived cracked.' })
  SUPPORT_INBOX.push(mailConv)
  const emailChannel = SUPPORT_CHANNELS.find((c) => c.channel === 'EMAIL')
  const before = emailChannel.status
  try {
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')

    // Settings > Email: provider, mailbox, server secret status (never values), redirect URI and push endpoint with a placeholder.
    GMAIL.connected = false
    await goto('/support/settings?tab=email')
    await waitFor(`!!document.querySelector('[data-testid=email-settings]') && !!document.querySelector('[data-testid=gsecret-client_secret]')`, 'email settings')
    await waitFor(`document.querySelector('[data-testid=gsecret-client_secret]').innerText.includes('Configured') && document.querySelector('[data-testid=gsecret-push_oidc]').innerText.includes('Not set')`, 'secret status')
    assert(await evaluate(bodyHasAll('Email: Google Workspace (Gmail)', 'Shared support mailbox', 'Connect Google Workspace', 'GOOGLE_OAUTH_CLIENT_SECRET', 'Authorised redirect URI', 'Pub/Sub push endpoint', 'gmail.readonly, gmail.send')), 'email settings content')
    assert(await evaluate(`document.querySelector('[data-testid=email-status] [data-status], [data-testid=email-status]')?.innerText.includes('Setup Required')`), 'not connected before OAuth')
    assert(await evaluate(`[...document.querySelectorAll('[data-testid=google-urls] code')].some((c) => c.innerText.includes('token=<GMAIL_PUSH_TOKEN>'))`), 'push URL placeholder')
    assert(!(await evaluate(`[...document.querySelectorAll('input')].some((i) => i.type === 'password' || /secret|token|password/i.test(i.id))`)), 'a password / secret input is on the page')
    await screenshot('240-support-email-settings')

    // Connect: the server builds the Google URL; the (mock) callback sends the browser back with gmail=connected.
    await click('[data-testid=connect-google]', 'Connect Google Workspace')
    await waitFor(`document.querySelector('[data-testid=email-notice]')?.innerText.includes('Google Workspace connected')`, 'connected notice')
    await waitFor(`!location.search.includes('gmail=')`, 'return parameters removed')
    assert(GMAIL.startCalls === 1, 'start called')
    await waitFor(bodyHas('Connected as support@alton.example.'), 'connected status from the server')
    await click('[data-testid=email-events] button', 'Replay')
    await waitFor(`document.querySelector('[data-testid=email-notice]')?.innerText.includes('Replayed')`, 'replay')
    // An error return explains the reason.
    await goto('/support/settings?tab=email&gmail=error&reason=wrong_mailbox')
    await waitFor(`document.querySelector('[data-testid=email-notice]')?.innerText.includes('another Google account than the support mailbox')`, 'error reason')

    // Email conversation: thread with headers, attachments (blocked one listed), sanitised formatted view in a sandbox.
    emailChannel.status = 'CONNECTED'
    await goto('/support/emails?c=sc-mail')
    await waitFor(`!!document.querySelector('[data-testid=email-em1]')`, 'email thread')
    await waitFor(`!!document.querySelector('[data-testid=mail-reply-bar]')`, 'thread ready')
    await click('[data-testid=email-em1] button[aria-expanded]')
    await waitFor(`!!document.querySelector('[data-testid=email-recipients]')`, 'recipient details')
    assert(await evaluate(bodyHasAll('Cracked basin', 'Ravi Kumar <ravi@customer.example>', 'boss@customer.example', 'photo.jpg', 'setup.exe: not stored (blocked type)')), 'email card content')
    await click('[data-testid=email-toggle-format]', 'Formatted view')
    await waitFor(`!!document.querySelector('[data-testid=email-html-frame]')`, 'formatted frame')
    const frame = await evaluate(`(() => { const f = document.querySelector('[data-testid=email-html-frame]'); return { sandbox: f.getAttribute('sandbox'), doc: f.getAttribute('srcdoc') } })()`)
    assert(frame.sandbox === 'allow-popups allow-popups-to-escape-sandbox' && !frame.sandbox.includes('allow-scripts') && !frame.sandbox.includes('allow-same-origin'), `sandbox: ${frame.sandbox}`)
    assert(frame.doc.includes("default-src 'none'") && frame.doc.includes('<b>cracked</b>') && !/<script/i.test(frame.doc), 'frame content')
    await screenshot('241-support-email-thread')

    // Reply: recipients from the email, subject kept for threading; the result is Pending until Gmail confirms.
    GMAIL.sendOutcome = 'PENDING'
    const sendsBefore = GMAIL.sendCalls.length
    await click('[data-testid=mail-reply-bar] button', 'Reply all')
    await waitFor(`!!document.querySelector('[data-testid=email-compose]') && document.querySelector('#em-to')?.value === 'ravi@customer.example'`, 'reply dialog')
    assert(await evaluate(`document.querySelector('#em-cc').value === 'boss@customer.example' && document.querySelector('#em-subject').value === 'Re: Cracked basin' && document.querySelector('#em-subject').disabled`), 'reply all recipients and subject')
    await fillEditor('#em-body', 'We are sending a replacement.')
    await evaluate(`(() => { const b = document.querySelector('[data-testid=email-send]'); b.click(); b.click(); b.click() })()`)
    await waitFor(`document.querySelector('[data-testid=email-send-result]')?.dataset.state === 'PENDING'`, 'pending result')
    await sleep(500)
    assert(GMAIL.sendCalls.length - sendsBefore === 1, `repeated clicks sent ${GMAIL.sendCalls.length - sendsBefore} requests`)
    const req = GMAIL.sendCalls.at(-1)
    assert(req.mode === 'REPLY_ALL' && req.reply_to_email_id === 'em1' && req.include_signature === true && /^[0-9a-f-]{36}$/.test(req.idempotency_key) && req.subject === undefined, `send request: ${JSON.stringify(req)}`)
    assert(!(await evaluate(`document.querySelector('[data-testid=email-compose]').innerText.includes('Sent: Gmail accepted')`)), 'shown as sent')
    assert(req.format === undefined, 'plain text sent as plain text')
    await screenshot('242-support-email-pending')
    await click('[data-testid=email-compose-close]')

    // New email from the Emails page: Failed is shown as Failed (with Try again), then Sent only when Gmail accepted.
    GMAIL.sendOutcome = 'FAILED'
    await click('[data-testid=new-email]')
    await waitFor(`!!document.querySelector('[data-testid=email-compose]') && !!document.querySelector('#em-to')`, 'new email dialog')
    await fill('#em-to', 'not-an-address')
    await fill('#em-subject', 'Your replacement')
    await fillEditor('#em-body', 'Dispatched today.')
    await click('[data-testid=email-send]', 'Send')
    await waitFor(bodyHas('Not an email address: not-an-address'), 'recipient validation')
    await fill('#em-to', 'ravi@customer.example')
    await click('[data-testid=email-send]', 'Send')
    await waitFor(`document.querySelector('[data-testid=email-send-result]')?.dataset.state === 'FAILED'`, 'failed result')
    assert(await evaluate(bodyHasAll('Gmail refused the message', 'Try again')), 'failure shown')
    GMAIL.sendOutcome = 'SENT'
    await click('[data-testid=email-compose] button', 'Try again')
    const keyBefore = GMAIL.sendCalls.at(-1).idempotency_key
    await click('[data-testid=email-send]', 'Send')
    await waitFor(`document.querySelector('[data-testid=email-send-result]')?.dataset.state === 'SENT'`, 'sent result')
    assert(GMAIL.sendCalls.at(-1).idempotency_key !== keyBefore && GMAIL.sendCalls.at(-1).mode === 'NEW', 'try again uses a new request key')
    await click('[data-testid=email-compose-close]')

    // Not connected: composing is refused with the reason, nothing is sent.
    GMAIL.connected = false
    const n = GMAIL.sendCalls.length
    await click('[data-testid=new-email]')
    await waitFor(`!!document.querySelector('[data-testid=email-blocked]')`, 'blocked when not connected')
    assert(GMAIL.sendCalls.length === n, 'sent while not connected')
    await click('[data-testid=email-compose-close]')
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
    SUPPORT_INBOX.splice(SUPPORT_INBOX.indexOf(mailConv), 1)
    emailChannel.status = before
    GMAIL.connected = false
  }
})

await step('Email sync progress: batches continue on the server, progress and remaining counts, duplicate runs prevented, Retry after a failure, page can be left', async () => {
  const PERMS = ['support.view', 'support.manage_tickets', 'support.assign', 'support.reply', 'support.manage_integrations', 'support.view_reports', 'support.manage_settings']
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  const emailChannel = SUPPORT_CHANNELS.find((c) => c.channel === 'EMAIL')
  const before = emailChannel.status
  const none = { queue: 0, queue_ready: 0, failed: 0, attachments: 0, attachments_ready: 0, attachments_failed: 0, discovery: false }
  const job = { id: 'j1', reason: 'MANUAL', status: 'RUNNING', days: 7, discovery_done: true, pages: 4, discovered: 1800, processed: 450, stored: 440, duplicates: 10, confirmed: 0,
    ignored: 0, failed: 0, batches: 40, remaining: 1350, started_at: NOW, finished_at: null, last_batch_at: NOW, last_error: null, failure_stage: null }
  GMAIL.connected = true; emailChannel.status = 'CONNECTED'
  try {
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')
    await setViewport(1440, 900)
    // Before the migration: the buttons work as before, with a note instead of progress.
    SYNC.status = null
    await goto('/support/settings?tab=email')
    await waitFor(`!!document.querySelector('[data-testid=email-sync-panel]') && document.querySelector('[data-testid=email-sync-panel]').innerText.includes('Progress appears once migration')`, 'pre-migration note')
    // A full re-sync in progress: bar, processed / remaining, attachments still downloading; Full re-sync cannot start twice.
    SYNC.status = { running: false, full_requested: false, batch_no: 41, last_batch_at: NOW, last_batch: { fetched: 12, stored: 12, attachments: 3, bytes: 3145728, duration_ms: 9200, ok: true },
      last_error: null, last_error_stage: null, last_error_at: null, remaining: { ...none, queue: 1350, queue_ready: 1350, attachments: 40, attachments_ready: 40 }, job }
    SYNC.schedule = { scheduler_available: true, scheduled: true, job: { schedule: '*/2 * * * *', active: true }, secrets_configured: true,
      last_run: { status: 'succeeded', start_time: NOW, message: null } }
    await goto('/support/settings?tab=email')
    await waitFor(`document.querySelector('[data-testid=email-sync-state]')?.dataset.state === 'CONTINUING'`, 'sync in progress')
    await waitFor(`document.querySelector('[data-testid=email-sync-schedule]')?.innerText.includes('Automatic sync: every 2 minutes on the server')`, 'schedule shown')
    assert(await evaluate(`document.querySelector('[data-testid=email-sync-bar]').getAttribute('aria-valuenow') === '25'
      && document.querySelector('[data-testid=email-sync-lines]').innerText.includes('450 of 1,800 new messages processed')
      && document.querySelector('[data-testid=email-sync-lines]').innerText.includes('40 attachments still downloading')
      && document.querySelector('[data-testid=email-sync-last]').innerText.includes('12 fetched (12 new), 3 attachments (3.0 MB) in 9.2 s')
      && document.querySelector('[data-testid=email-sync-last]').innerText.includes('you can leave this page')`), 'progress details')
    assert(await evaluate(`document.querySelector('[data-testid=email-sync-full]').disabled && !document.querySelector('[data-testid=email-sync-now]').disabled`), 'Full re-sync locked while one runs')
    await screenshot('267-email-sync-progress')
    const n0 = GMAIL.syncCalls.length
    await evaluate(`(() => { const b = document.querySelector('[data-testid=email-sync-now]'); b.click(); b.click(); b.click() })()`)
    await waitFor(`document.querySelector('[data-testid=email-notice]')?.innerText.includes('Continuing in the background')`, 'continuing notice')
    assert(GMAIL.syncCalls.length === n0 + 1 && (GMAIL.syncCalls.at(-1).action ?? 'sync') === 'sync', `one request for three clicks: ${GMAIL.syncCalls.length - n0}`)
    // A batch running right now: both buttons wait.
    SYNC.status = { ...SYNC.status, running: true }
    await goto('/support/settings?tab=email')
    await waitFor(`document.querySelector('[data-testid=email-sync-state]')?.dataset.state === 'RUNNING' && document.querySelector('[data-testid=email-sync-now]').disabled`, 'running: buttons wait')
    SYNC.schedule = { ...SYNC.schedule, secrets_configured: false, last_run: null }
    await goto('/support/settings?tab=email')
    await waitFor(`document.querySelector('[data-testid=email-sync-schedule]')?.innerText.includes('Vault secrets alton_project_url / alton_gmail_cron_secret are missing')`, 'schedule warning')
    // A failed batch and messages that gave up: needs attention, Retry.
    SYNC.status = { ...SYNC.status, running: false, job: null, last_batch: { ok: false, stage: 'history' }, last_error: 'Sync stopped at history: Gmail API error 503: backend',
      last_error_stage: 'history', last_error_at: NOW, remaining: { ...none, failed: 2, attachments: 1, attachments_failed: 1 } }
    await goto('/support/settings?tab=email')
    await waitFor(`document.querySelector('[data-testid=email-sync-state]')?.dataset.state === 'ATTENTION' && !!document.querySelector('[data-testid=email-sync-retry]')`, 'needs attention')
    assert(await evaluate(`document.querySelector('[data-testid=email-sync-error]').innerText.includes('Gmail API error 503')
      && document.querySelector('[data-testid=email-sync-lines]').innerText.includes('2 messages could not be fetched after 5 attempts')`), 'error and failures shown')
    await click('[data-testid=email-sync-retry]')
    for (let i = 0; i < 30 && GMAIL.syncCalls.at(-1)?.action !== 'retry'; i++) await sleep(100)
    assert(GMAIL.syncCalls.at(-1).action === 'retry', 'retry request')
    assert(!(await evaluate(`document.body.innerText.includes('ya29') || document.body.innerText.includes('refresh_token')`)), 'no token on the page')
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
    emailChannel.status = before
    SYNC.status = null; SYNC.schedule = null; GMAIL.connected = false
  }
})

await step('Support ticket fields: field builder (system fields locked, drag and drop, add custom field, required, remove, unsaved-changes warning, stale save refused), dynamic New Ticket form (order, required validation, two columns / one on mobile), Product Master selector (search, several products, quantities), ticket page values and products with Edit', async () => {
  const PERMS = ['support.view', 'support.manage_tickets', 'support.assign', 'support.reply', 'support.manage_settings', 'support_ticket_fields.view', 'support_ticket_fields.create',
    'support_ticket_fields.update', 'support_ticket_fields.delete', 'support_ticket_products.view', 'support_ticket_products.manage']
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  TF.on = true; TF.stamp = 's0'; TF.layout = null; TF.values = {}; TF.links = []; TF.saves = []; TF.creates = []; TF.fieldSaves = []; TF.productSaves = []
  TF.defs = [tfDef('tfd1', 'cf_complaint_type', 'Complaint type', 'PICKLIST', { options: [{ id: 'opt_damaged', label: 'Damaged' }, { id: 'opt_missing', label: 'Missing part' }] }, { is_required: true, value_count: 4 }),
    tfDef('tfd2', 'cf_units_affected', 'Units affected', 'NUMBER', { number_kind: 'INTEGER', decimals: 0, min: 1, max: 1000 })]
  const usedOrder = `[...document.querySelectorAll('[data-testid=used-fields] > li')].map((li) => li.dataset.testid.replace('used-', '')).join()`
  try {
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')
    await setViewport(1440, 900)
    await goto('/support/settings?tab=fields')
    await waitFor(`!!document.querySelector('[data-testid=ticket-field-builder]')`, 'builder')
    assert(await evaluate(`['ticket_number','ticket_id','company_id','created_at'].every((k) => !!document.querySelector('[data-testid=system-' + k + ']'))`), 'system fields shown, locked')
    assert((await evaluate(usedOrder)) === 'subject,customer,products,customer_phone,customer_email,priority,assigned_agent,category,subcategory,department,description', await evaluate(usedOrder))
    assert(await evaluate(`document.querySelector('[data-testid=used-subject] button[aria-label="Remove Subject from the form"]').disabled`), 'Subject cannot be removed')
    assert(await evaluate(`document.querySelector('[data-testid=custom-field-count]').innerText === '2 of 25 custom fields used'`), 'counter')
    assert(await evaluate(`!!document.querySelector('[data-testid=unused-cf_complaint_type]') && document.querySelector('[data-testid=unused-cf_units_affected]').innerText.includes('Numerical')`), 'unused custom fields with type')
    await fill('[data-testid=field-search]', 'units')
    await waitFor(`!document.querySelector('[data-testid=unused-cf_complaint_type]') && !!document.querySelector('[data-testid=unused-cf_units_affected]')`, 'search filters unused fields')
    await fill('[data-testid=field-search]', '')
    // Add Custom Field (modal): key generated from the label, created now, placed at the end of the working layout.
    await click('[data-testid=add-custom-field]')
    await waitFor(`!!document.querySelector('[data-testid=custom-field-dialog]')`, 'custom field dialog')
    await fill('#cf-label', 'Claim amount')
    await choose('#cf-type', 'Currency')
    await waitFor(`document.querySelector('[data-testid=cf-key]').innerText.includes('cf_claim_amount') && document.querySelector('#cf-cur').value === 'INR'`, 'key preview and INR default')
    await screenshot('270-ticket-custom-field-dialog')
    await click('[data-testid=cf-save]')
    await waitFor(`!document.querySelector('[data-testid=custom-field-dialog]') && !!document.querySelector('[data-testid=used-cf_claim_amount]')`, 'created and placed on the form')
    assert(TF.fieldSaves[0].p.field_type === 'CURRENCY' && TF.fieldSaves[0].p.field_label === 'Claim amount', JSON.stringify(TF.fieldSaves[0]))
    await waitFor(`!!document.querySelector('[data-testid=unsaved-changes]')`, 'unsaved changes shown')
    // Drag an unused field into the form, before Priority.
    await evaluate(`(() => {
      const src = document.querySelector('[data-testid=unused-cf_complaint_type]'); const dst = document.querySelector('[data-testid=used-priority]'); const dt = new DataTransfer()
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
      const r = dst.getBoundingClientRect()
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 2 }))
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 2 }))
      return true })()`)
    await waitFor(`${usedOrder}.includes('customer_email,cf_complaint_type,priority')`, 'dragged into place')
    // Reorder by dragging within the form: Description to just after Products.
    await evaluate(`(() => {
      const src = document.querySelector('[data-testid=used-description]'); const dst = document.querySelector('[data-testid=used-customer_phone]'); const dt = new DataTransfer()
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
      const r = dst.getBoundingClientRect()
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 2 }))
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 2 }))
      return true })()`)
    await waitFor(`${usedOrder}.startsWith('subject,customer,products,description,customer_phone')`, 'reordered by drag')
    // Remove Department and Subcategory (they become unused); make Category required; move Claim amount up with the keyboard button.
    await click('[data-testid=used-department] button[aria-label="Remove Department from the form"]')
    await click('[data-testid=used-subcategory] button[aria-label="Remove Subcategory from the form"]')
    await waitFor(`!!document.querySelector('[data-testid=unused-department]')`, 'removed field listed as unused')
    await click('[data-testid=used-category] input[type=checkbox]')
    await click('[data-testid=used-cf_claim_amount] button[aria-label="Move Claim amount up"]')
    assert(await evaluate(`!!document.querySelector('[data-testid=used-category] [data-testid=required-mark]') && !!document.querySelector('[data-testid=used-cf_complaint_type] [data-testid=required-mark]')`), 'required marks')
    await screenshot('271-ticket-field-builder')
    // Leaving with unsaved changes asks first (declined: stays on the builder).
    await evaluate(`window.__confirms = []; window.confirm = (m) => { window.__confirms.push(m); return false }`)
    await click('button', 'Agents')
    assert(await evaluate(`window.__confirms.length === 1 && /unsaved changes/.test(window.__confirms[0]) && !!document.querySelector('[data-testid=ticket-field-builder]')`), 'tab change warned and cancelled')
    await click('a[href="/support/tickets"]')
    assert(await evaluate(`window.__confirms.length === 2 && location.pathname === '/support/settings'`), 'link warned and cancelled')
    // Save.
    await click('[data-testid=save-layout]')
    await waitFor(`!document.querySelector('[data-testid=unsaved-changes]') && ${bodyHas('Ticket fields saved')}`, 'saved')
    const sent = TF.saves.at(-1)
    const keys = sent.p_used.map((x) => x.standard_key ?? x.field_definition_id).join()
    assert(sent.p_stamp === 's0' && keys === 'subject,customer,products,description,customer_phone,customer_email,tfd1,priority,assigned_agent,tfd3,category', keys)
    assert(sent.p_used.find((x) => x.standard_key === 'category').is_required === true, 'category required sent')
    // Someone else saved meanwhile: refused with a clear message, nothing lost.
    TF.stamp = 'other-admin'
    await click('[data-testid=unused-cf_units_affected] button[aria-label="Add Units affected to the form"]')
    await click('[data-testid=save-layout]')
    await waitFor(bodyHas('Someone else changed the ticket fields'), 'stale save refused')
    assert(await evaluate(`!!document.querySelector('[data-testid=unsaved-changes]') && !!document.querySelector('[data-testid=used-cf_units_affected]')`), 'working copy kept')
    // Cancel discards the working copy (asks first), so nothing is left unsaved.
    await evaluate(`window.confirm = () => true`)
    await click('button', 'Cancel')
    await waitFor(`!document.querySelector('[data-testid=unsaved-changes]') && !document.querySelector('[data-testid=used-cf_units_affected]')`, 'changes discarded')
    await goto('/support/tickets')

    // New Ticket with the configured layout.
    await waitFor(`!!document.querySelector('[data-testid=new-ticket]')`, 'tickets page')
    await click('[data-testid=new-ticket]')
    await waitFor(`!!document.querySelector('[data-testid=new-ticket-form]')`, 'configured form')
    const labels = await evaluate(`[...document.querySelectorAll('[data-testid=new-ticket-form] label')].map((l) => l.innerText.trim()).filter(Boolean).join('|')`)
    assert(/^Subject \*\|Customer\|Products \(Product Master\)\|Description\|Phone\|Email\|Complaint type \*\|Priority\|Assigned agent\|Claim amount\|Category \*/.test(labels), labels)
    assert(!labels.includes('Department') && !labels.includes('Subcategory'), 'removed fields not on the form')
    assert(await evaluate(`getComputedStyle(document.querySelector('[data-testid=new-ticket-form] > div')).gridTemplateColumns.split(' ').length === 2`), 'two columns on desktop')
    await click('[data-testid=create-ticket]')
    await waitFor(`!!document.querySelector('[data-testid=missing-fields]')`, 'required validation')
    const missing = await evaluate(`document.querySelector('[data-testid=missing-fields]').innerText`)
    assert(/Subject/.test(missing) && /Complaint type/.test(missing) && /Category/.test(missing) && /Customer/.test(missing), missing)
    assert(TF.creates.length === 0, 'nothing sent while required fields are missing')
    await fill('#tk-subject', 'Basin cracked on arrival')
    await fill('#tk-email', 'ravi@customer.example')
    await fill('#tk-category', 'Damage')
    await choose('#tk-cf-cf_complaint_type', 'Damaged')
    await fill('#tk-cf-cf_claim_amount', '1500.5')
    // Product Master selector: search by name and by EAN, two products, quantity.
    await fill('#tk-products', 'basin')
    await waitFor(`!!document.querySelector('[data-testid=product-hit-WB-500]')`, 'product results')
    assert(await evaluate(`document.querySelector('[data-testid=product-hit-WB-500]').innerText.includes('EAN 4006381333931') && document.querySelector('[data-testid=product-hit-WB-500]').innerText.includes('Code WHB-500')`), 'identifiers shown')
    await click('[data-testid=product-hit-WB-500]')
    await fill('#tk-products', 'PTC')
    await waitFor(`!!document.querySelector('[data-testid=product-hit-TAP-22]')`, 'search by product code')
    await click('[data-testid=product-hit-TAP-22]')
    await waitFor(`document.querySelectorAll('[data-testid=picked-products] > li').length === 2`, 'two products')
    await fill('[aria-label="Quantity of WB-500"]', '2')
    assert(await evaluate(`!document.querySelector('[data-testid=missing-fields]') && !document.querySelector('#tk-subject[aria-invalid=true]')`), 'errors clear once the fields are filled')
    await screenshot('272-new-ticket-custom-fields')
    await setViewport(390, 844)
    await sleep(200)
    assert(await evaluate(`getComputedStyle(document.querySelector('[data-testid=new-ticket-form] > div')).gridTemplateColumns.split(' ').length === 1 && document.documentElement.scrollWidth <= innerWidth
      && (() => { const b = document.querySelector('[data-testid=new-ticket-form] > div'); return b.scrollWidth <= b.clientWidth + 1 })()`), 'one column on mobile, no sideways scroll')
    await screenshot('273-new-ticket-mobile')
    await setViewport(1440, 900)
    await click('[data-testid=create-ticket]')
    await waitFor(`location.pathname === '/support/tickets/st9'`, 'ticket created')
    const c = TF.creates[0]
    assert(c.subject === 'Basin cracked on arrival' && c.category === 'Damage' && c.custom_fields.cf_complaint_type === 'opt_damaged' && c.custom_fields.cf_claim_amount?.amount === '1500.5', JSON.stringify(c))
    assert(c.products.length === 2 && c.products[0].product_id === 'pm1' && c.products[0].quantity === '2' && c.products[1].product_id === 'pm2', JSON.stringify(c.products))

    // Ticket page: values in order, products, Edit.
    await waitFor(`!!document.querySelector('[data-testid=ticket-custom-fields]') && !!document.querySelector('[data-testid=ticket-products]')`, 'extras on the ticket page')
    assert(await evaluate(`document.querySelector('[data-testid=cf-value-cf_complaint_type]').innerText.includes('Damaged') && /1,500\\.50/.test(document.querySelector('[data-testid=cf-value-cf_claim_amount]').innerText)`), 'values shown')
    assert(await evaluate(`document.querySelector('[data-testid=ticket-product-WB-500]').innerText.includes('Wall Hung Basin White') && document.querySelector('[data-testid=ticket-product-WB-500]').innerText.includes('2 PCS')`), 'product with quantity')
    await screenshot('274-ticket-custom-fields-products')
    await click('[data-testid=edit-custom-fields]')
    await fill('#te-cf-cf_units_affected', '3')
    await click('[data-testid=save-custom-fields]')
    await waitFor(bodyHas('1 field updated.'), 'custom field edited')
    assert(JSON.stringify(TF.fieldSaves.at(-1).p_values) === JSON.stringify({ cf_units_affected: '3' }), JSON.stringify(TF.fieldSaves.at(-1)))
    await click('[data-testid=edit-ticket-products]')
    await click('[aria-label="Remove TAP-22"]')
    await click('[data-testid=save-ticket-products]')
    await waitFor(`${bodyHas('Products: 1 removed.')} && !document.querySelector('[data-testid=ticket-product-TAP-22]')`, 'product removed')
    assert(TF.productSaves.at(-1).p_items.length === 1 && TF.productSaves.at(-1).p_items[0].product_id === 'pm1', JSON.stringify(TF.productSaves.at(-1)))
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
    TF.on = false
    await setViewport(1440, 900)
  }
})

await step('Support live updates: red badges for WhatsApp / Emails / Calls (99+, hidden at 0), updated without a page reload; lists reload in place keeping the open email and unsent text; missed calls handled; one polling loop', async () => {
  const PERMS = ['support.view', 'support.manage_tickets', 'support.assign', 'support.reply', 'support.manage_integrations']
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  const mailConv = supportConv('sc-mail', 'EMAIL', { subject: 'Cracked basin', customer_id: 'scu1', last_message_preview: 'The basin arrived cracked.' })
  SUPPORT_INBOX.push(mailConv)
  const emailChannel = SUPPORT_CHANNELS.find((c) => c.channel === 'EMAIL')
  const before = emailChannel.status
  LIVE.on = true; LIVE.handled = []
  LIVE.summary = { whatsapp_unread: 5, email_unread: 12, missed_calls: 3, stamps: { whatsapp: 'w1', email: 'e1', calls: 'c1' }, at: NOW }
  MAILBOX.web = true; MAILBOX.state = {}; GMAIL.connected = true; emailChannel.status = 'CONNECTED'
  const badge = (k) => `document.querySelector('[data-testid=nav-badge-support-${k}]')?.innerText`
  try {
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')
    await setViewport(1440, 900)
    await goto('/support/overview')
    await waitFor(`${badge('whatsapp')} === '5' && ${badge('emails')} === '12' && ${badge('calls')} === '3'`, 'badges')
    assert(await evaluate(`(() => { const b = document.querySelector('[data-testid=nav-badge-support-emails]'); const link = b.closest('a').getBoundingClientRect(); const r = b.getBoundingClientRect()
      return b.classList.contains('bg-red-600') && b.classList.contains('text-white') && getComputedStyle(b).borderRadius !== '0px'
        && r.right <= link.right && r.right > link.right - 24 && Math.abs((r.top + r.bottom) / 2 - (link.top + link.bottom) / 2) < 3
        && b.getAttribute('aria-label') === '12 unread emails' })()`), 'red round badge on the right, vertically centred, with a label')
    await screenshot('268-support-badges')
    // Counts change on the server: the badges follow within the 3-second check, without reloading the page.
    await evaluate(`window.__noReload = 'still here'`)
    LIVE.summary = { ...LIVE.summary, email_unread: 150, whatsapp_unread: 0, stamps: { ...LIVE.summary.stamps, email: 'e2', whatsapp: 'w2' } }
    await waitFor(`${badge('emails')} === '99+' && !document.querySelector('[data-testid=nav-badge-support-whatsapp]')`, '99+ and hidden at zero', 6000)
    assert(await evaluate(`window.__noReload === 'still here'`), 'the page was reloaded')

    // Emails: an open thread and an unsent message survive new mail arriving (in-place reloads).
    await goto('/support/emails?folder=all&c=sc-mail')
    await waitFor(`!!document.querySelector('[data-testid=email-em1]')`, 'thread open')
    await click('[data-testid=new-email]')
    await waitFor(`!!document.querySelector('#em-body')`, 'compose')
    await fill('#em-subject', 'Draft in progress')
    await fillEditor('#em-body', 'Half-written reply')
    const listCalls = rpcCalls('support_email_mailbox').length
    const threadCalls = rpcCalls('support_email_thread').length
    await evaluate(`window.__noReload = 'mail'`)
    LIVE.summary = { ...LIVE.summary, email_unread: 13, stamps: { ...LIVE.summary.stamps, email: 'e3' } }
    for (let i = 0; i < 60 && (rpcCalls('support_email_mailbox').length === listCalls || rpcCalls('support_email_thread').length === threadCalls); i++) await sleep(100)
    assert(rpcCalls('support_email_mailbox').length > listCalls && rpcCalls('support_email_thread').length > threadCalls, 'list and thread reloaded when the email stamp moved')
    assert(await evaluate(`window.__noReload === 'mail' && /c=sc-mail/.test(location.search) && !!document.querySelector('[data-testid=email-em1]')
      && document.querySelector('#em-subject').value === 'Draft in progress' && document.querySelector('#em-body').innerText.includes('Half-written reply')`), 'open email and unsent text kept')
    await click('[data-testid=email-discard]')

    // Calls: missed calls needing attention, Mark all handled clears the badge at once.
    await goto('/support/calls')
    await waitFor(`!!document.querySelector('[data-testid=missed-calls-banner]') && document.querySelector('[data-testid=missed-calls-banner]').innerText.includes('3 missed calls need attention')`, 'missed calls banner')
    await click('[data-testid=handle-all-missed]')
    await waitFor(`!document.querySelector('[data-testid=nav-badge-support-calls]') && document.querySelector('[data-testid=missed-calls-banner]')?.innerText.includes('3 missed calls marked handled')`, 'handled')
    assert(LIVE.handled.length === 1 && LIVE.handled[0] === null, 'mark all handled request')

    // One loop for the whole app: after moving between pages, about one summary request per 3 s.
    await goto('/support/overview')
    await click('a[href="/support/emails"]')
    await click('a[href="/support/whatsapp"]')
    await click('a[href="/support/calls"]')
    await sleep(800)
    const n0 = rpcCalls('support_live_summary').length
    await sleep(6500)
    const n = rpcCalls('support_live_summary').length - n0
    assert(n >= 1 && n <= 4, `summary requests in 6.5 s: ${n} (one loop, 3 s apart)`)
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
    SUPPORT_INBOX.splice(SUPPORT_INBOX.indexOf(mailConv), 1)
    emailChannel.status = before
    LIVE.on = false; LIVE.summary = null; MAILBOX.web = false; MAILBOX.state = {}; GMAIL.connected = false
  }
})

await step('Email workspace: rail, folders with counts, labels, list rows with star / attachment / unread, bulk actions, search operators and advanced search, thread with print and forward, formatted compose, drafts, phone layout', async () => {
  const PERMS = ['support.view', 'support.manage_tickets', 'support.assign', 'support.reply', 'support.manage_integrations']
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  const mailConv = supportConv('sc-mail', 'EMAIL', { subject: 'Cracked basin', customer_id: 'scu1', last_message_preview: 'The basin arrived cracked.' })
  SUPPORT_INBOX.push(mailConv)
  const emailChannel = SUPPORT_CHANNELS.find((c) => c.channel === 'EMAIL')
  const before = emailChannel.status
  MAILBOX.web = true; MAILBOX.state = {}; GMAIL.connected = true; GMAIL.sendOutcome = 'SENT'; emailChannel.status = 'CONNECTED'
  try {
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')
    await setViewport(1440, 900)

    // Layout: rail (Calendar disabled), folders with the Inbox unread count, labels, rows.
    await goto('/support/emails')
    await waitFor(`!!document.querySelector('[data-testid=mail-row-sc-mail]') && !!document.querySelector('[data-testid=mail-rail]')`, 'mail list')
    assert(MAILBOX.queries.at(-1).folder === 'INBOX' && MAILBOX.queries.at(-1).limit === 50, `first query ${JSON.stringify(MAILBOX.queries.at(-1))}`)
    assert(await evaluate(`document.querySelector('[data-testid=mail-count-INBOX]')?.innerText === '1' && !!document.querySelector('[data-testid=mail-rail-calendar][aria-disabled=true]')
      && document.querySelector('[data-testid=mail-labels]').innerText.includes('Damage') && document.querySelector('[data-testid=mail-page-label]').innerText === '1–2 of 2'`), 'sidebar, rail and page label')
    assert(await evaluate(`document.querySelector('[data-testid=mail-row-sc-mail]').dataset.unread === 'true' && !!document.querySelector('[data-testid=mail-row-sc-mail] [data-testid=mail-has-attachment]')`), 'unread row with attachment')
    await screenshot('258-email-workspace-inbox')

    // Star from the row; select and archive in bulk; selected count shown.
    await click('[data-testid=mail-row-sc-mail] [data-testid=mail-star]')
    for (let i = 0; i < 30 && MAILBOX.actions.at(-1)?.action !== 'STAR'; i++) await sleep(100)
    assert(MAILBOX.actions.at(-1).action === 'STAR' && MAILBOX.actions.at(-1).ids.join() === 'sc-mail', 'star request')
    await click('[data-testid=mail-row-sc-mail] [data-testid=mail-row-check]')
    await waitFor(`document.querySelector('[data-testid=mail-selected-count]')?.innerText === '1 selected'`, 'selected count')
    await click('[data-testid=mail-archive]')
    for (let i = 0; i < 30 && MAILBOX.actions.at(-1)?.action !== 'ARCHIVE'; i++) await sleep(100)
    assert(MAILBOX.actions.at(-1).ids.join() === 'sc-mail', 'archive request')
    await waitFor(`!document.querySelector('[data-testid=mail-row-sc-mail]') && document.querySelector('[data-testid=mail-notice]')?.innerText.includes('Archived')`, 'archived')
    // Folders: Starred shows it; All mail shows it with its (archived) state.
    await click('[data-testid=mail-folder-STARRED]')
    await waitFor(`!!document.querySelector('[data-testid=mail-row-sc-mail]')`, 'starred folder')
    assert(MAILBOX.queries.at(-1).folder === 'STARRED' && /folder=starred/.test(await evaluate('location.search')), 'starred query and URL')
    await click('[data-testid=mail-folder-INBOX]')

    // Search operators: sent to the server as filters, shown as chips; advanced search writes the same operators.
    await fill('[data-testid=mail-search]', 'from:ravi has:attachment basin')
    await evaluate(`document.querySelector('[data-testid=mail-search]').focus()`)
    // Enter with its key text, as a keyboard sends it (this is what submits a form).
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    for (let i = 0; i < 30 && MAILBOX.queries.at(-1)?.from !== 'ravi'; i++) await sleep(100)
    const q = MAILBOX.queries.at(-1)
    assert(q.from === 'ravi' && q.has_attachment === true && q.q === 'basin', `search filters ${JSON.stringify(q)}`)
    await waitFor(`!!document.querySelector('[data-testid=mail-chip-from]') && !!document.querySelector('[data-testid=mail-chip-has_attachment]')`, 'filter chips')
    await click('[data-testid=mail-advanced-toggle]')
    await waitFor(`!!document.querySelector('[data-testid=mail-advanced]')`, 'advanced search')
    assert(await evaluate(`document.querySelector('#adv-from').value === 'ravi' && document.querySelector('[data-testid=adv-attachment]').checked`), 'advanced panel reads the operators')
    await fill('#adv-subject', 'Cracked')
    await fill('[data-testid=adv-after]', '2026-11-01')
    await click('[data-testid=adv-search]')
    for (let i = 0; i < 30 && MAILBOX.queries.at(-1)?.subject !== 'Cracked'; i++) await sleep(100)
    assert(MAILBOX.queries.at(-1).subject === 'Cracked' && MAILBOX.queries.at(-1).after === '2026-11-01', `advanced filters ${JSON.stringify(MAILBOX.queries.at(-1))}`)
    await goto('/support/emails?folder=all')
    await waitFor(`!!document.querySelector('[data-testid=mail-row-sc-mail]')`, 'all mail')

    // Thread: subject, collapsible message, attachments, print, support details with the existing ticket / customer / notes.
    await click('[data-testid=mail-row-sc-mail]')
    await waitFor(`document.querySelector('[data-testid=mail-subject]')?.innerText === 'Cracked basin' && !!document.querySelector('[data-testid=email-em1][data-expanded=true]')`, 'thread')
    assert(await evaluate(`!!document.querySelector('[data-testid=mail-print]') && !!document.querySelector('[data-testid=mail-details] [data-testid=wa-info-ticket]')
      && !!document.querySelector('[data-testid=mail-details] [data-testid=wa-info-notes]') && !!document.querySelector('[data-testid=mail-thread-star]')`), 'thread toolbar and details')
    await click('[data-testid=email-em1] header > div.cursor-pointer')
    await waitFor(`!!document.querySelector('[data-testid=email-em1][data-expanded=false]')`, 'message collapses')
    await click('[data-testid=email-em1]')
    await waitFor(`!!document.querySelector('[data-testid=email-em1][data-expanded=true]')`, 'message expands')
    await screenshot('259-email-workspace-thread')

    // Forward: subject Fwd:, the forwarded block in the editor, a new email (not a reply).
    await click('[data-testid=mail-forward]')
    await waitFor(`!!document.querySelector('[data-testid=email-compose]') && document.querySelector('#em-subject')?.value === 'Fwd: Cracked basin'
      && document.querySelector('#em-body').innerText.includes('Forwarded message')`, 'forward window')
    await fill('#em-to', 'warehouse@alton.example')
    const n0 = GMAIL.sendCalls.length
    await click('[data-testid=email-send]')
    for (let i = 0; i < 30 && GMAIL.sendCalls.length === n0; i++) await sleep(100)
    const fw = GMAIL.sendCalls.at(-1)
    assert(fw.mode === 'NEW' && fw.subject === 'Fwd: Cracked basin' && fw.body.includes('From: Ravi Kumar <ravi@customer.example>') && fw.to.join() === 'warehouse@alton.example', `forward ${JSON.stringify(fw).slice(0, 300)}`)
    assert(fw.attachments.length === 1 && fw.attachments[0].file_name === 'photo.jpg' && fw.attachments[0].path.includes('/outbox/'), `forward copies the attachment: ${JSON.stringify(fw.attachments)}`)
    await waitFor(`document.querySelector('[data-testid=email-send-result]')?.dataset.state === 'SENT'`, 'forward sent')
    await click('[data-testid=email-compose-close]')

    // Formatted message: bold through the toolbar is sent as markup with format "markdown" (never HTML).
    await click('[data-testid=new-email]')
    await waitFor(`!!document.querySelector('[data-testid=email-compose]') && !!document.querySelector('#em-to')`, 'compose window')
    assert(await evaluate(`document.querySelector('[data-testid=email-from]').innerText.includes('support@alton.example')`), 'From shown')
    await fill('#em-to', 'ravi@customer.example')
    await fill('#em-subject', 'Replacement')
    await fillEditor('#em-body', 'Dispatched today')
    await evaluate(`(() => { const el = document.querySelector('#em-body'); el.focus(); document.execCommand('selectAll') })()`)
    await click('[data-testid=email-compose] button[aria-label="Bold (Ctrl+B)"]')
    await waitFor(`!!document.querySelector('#em-body b, #em-body strong')`, 'bold applied')
    // Draft auto-saved (existing form drafts, form key support.email), listed in Drafts.
    await waitFor(`document.querySelector('[data-testid=email-draft-state]')?.innerText === 'Draft saved'`, 'draft saved', 8000)
    assert(rpcCalls('erp_form_draft_save').at(-1).body.p_form_key === 'support.email' && rpcCalls('erp_form_draft_save').at(-1).body.p_data.formatted === true
      && !JSON.stringify(rpcCalls('erp_form_draft_save').at(-1).body.p_data).includes('<b>'), 'draft is markup, not HTML')
    const n1 = GMAIL.sendCalls.length
    await click('[data-testid=email-send]')
    for (let i = 0; i < 30 && GMAIL.sendCalls.length === n1; i++) await sleep(100)
    const rich = GMAIL.sendCalls.at(-1)
    assert(rich.format === 'markdown' && rich.body === '**Dispatched today**' && !/</.test(rich.body), `formatted send ${JSON.stringify(rich)}`)
    await waitFor(`document.querySelector('[data-testid=email-send-result]')?.dataset.state === 'SENT'`, 'sent')
    await click('[data-testid=email-compose-close]')
    // A draft left open is listed in Drafts and reopens in the compose window.
    await click('[data-testid=new-email]')
    await waitFor(`!!document.querySelector('#em-to')`, 'compose again')
    await fill('#em-to', 'meera@shop.example')
    await fill('#em-subject', 'Draft to keep')
    await click('[data-testid=email-save-draft]')
    await waitFor(`document.querySelector('[data-testid=email-draft-state]')?.innerText === 'Draft saved'`, 'draft saved by hand')
    await click('[data-testid=email-compose-close]')
    await click('[data-testid=mail-folder-DRAFTS]')
    await waitFor(`!!document.querySelector('[data-testid=mail-drafts]') && document.querySelector('[data-testid=mail-drafts]').innerText.includes('Draft to keep')`, 'drafts folder')
    await click('[data-testid=mail-drafts] li', 'Draft to keep')
    await waitFor(`document.querySelector('#em-subject')?.value === 'Draft to keep' && document.querySelector('#em-to').value === 'meera@shop.example'`, 'draft reopened')
    await click('[data-testid=email-discard]')
    await waitFor(`!document.querySelector('[data-testid=email-compose]')`, 'discarded')

    // Phone: list, menu drawer with folders, thread full screen with a back button; no horizontal scroll.
    await setViewport(390, 844)
    await goto('/support/emails?folder=all')
    await waitFor(`!!document.querySelector('[data-testid=mail-row-sc-mail]')`, 'mobile list')
    assert(await noHorizontalScroll(), 'mobile list scrolls horizontally')
    await click('button[aria-label="Main menu"]')
    await waitFor(`!!document.querySelector('[data-testid=mail-nav-drawer] [data-testid=mail-folder-INBOX]')`, 'folder drawer')
    await click('[data-testid=mail-nav-drawer] [data-testid=mail-folder-ALL]')
    await click('[data-testid=mail-row-sc-mail]')
    await waitFor(`!!document.querySelector('[data-testid=mail-thread]') && document.querySelector('[data-testid=mail-thread]').getBoundingClientRect().width >= 380`, 'mobile thread full screen')
    assert(await noHorizontalScroll(), 'mobile thread scrolls horizontally')
    await screenshot('260-email-workspace-mobile')
    await click('[data-testid=mail-back]')
    await waitFor(`!document.querySelector('[data-testid=mail-thread]')`, 'back to list')
    await cdp('Emulation.clearDeviceMetricsOverride')
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
    SUPPORT_INBOX.splice(SUPPORT_INBOX.indexOf(mailConv), 1)
    emailChannel.status = before
    MAILBOX.web = false; MAILBOX.state = {}; GMAIL.connected = false; GMAIL.sendOutcome = 'PENDING'
  }
})

await step('Email message tools: attachment chips in the list, preview with next / previous, thread with folded earlier emails, quoted text behind "…", per-email menu (show original, star, report phishing, trash with confirmation, copy link), download link', async () => {
  const PERMS = ['support.view', 'support.manage_tickets', 'support.assign', 'support.reply', 'support.manage_integrations']
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  const mailConv = supportConv('sc-mail', 'EMAIL', { subject: 'Cracked basin', customer_id: 'scu1', last_message_preview: 'The basin arrived cracked.' })
  SUPPORT_INBOX.push(mailConv)
  const emailChannel = SUPPORT_CHANNELS.find((c) => c.channel === 'EMAIL')
  const before = emailChannel.status
  const P = (n) => `${COMPANY_ID}/email/em2/${n}`
  const file = (id, file_name, content_type, size_bytes, path = P(file_name)) => ({ id, file_name, content_type, size_bytes, inline: false, storage_path: path, restricted: false })
  const earlier = (id, h, body) => ({ ...GMAIL_THREAD[0], id, message_id: `m-${id}`, body_text: body, at: new Date(Date.parse(NOW) - h * 3600000).toISOString(), unread: false,
    gmail_message_id: `${id}000000`, attachments: [], skipped_attachments: [] })
  const em2 = { ...GMAIL_THREAD[0], id: 'em2', message_id: 'm-em2', cc: [], unread: false, at: new Date(Date.parse(NOW) + 60000).toISOString(), gmail_message_id: 'eeee000002', has_html: false,
    body_text: 'Any update on the replacement?\n\nOn Mon, 16 Nov 2026 at 10:00, Support <support@alton.example> wrote:\n> We are checking with the warehouse.', skipped_attachments: [],
    attachments: [file('a-pdf', 'invoice.pdf', 'application/pdf', 4096), file('a-mp4', 'unboxing.mp4', 'video/mp4', 900000), file('a-csv', 'items.csv', 'text/csv', 40),
      file('a-docx', 'Quarterly damage report for the northern region.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 12000),
      { ...file('a-sens', 'bank-details.png', 'image/png', 300), storage_path: null, restricted: true }] }
  const added = [earlier('e0a', 30, 'First message about the basin.'), earlier('e0b', 20, 'Second message.'), earlier('e0c', 10, 'Third message.')]
  GMAIL_THREAD.unshift(...added)
  GMAIL_THREAD.push(em2)
  MAILBOX.web = true; MAILBOX.state = {}; MAILBOX.msg = {}; MAILBOX.msgActions = []; GMAIL.connected = true; GMAIL.sendOutcome = 'SENT'; emailChannel.status = 'CONNECTED'
  MAILBOX.files = { 'sc-mail': { count: 6, items: [
    { ...file('a-jpg', 'photo.jpg', 'image/jpeg', 20480, `${COMPANY_ID}/email/em1/1-photo.jpg`), email_id: 'em1' }, { ...file('a-png', 'damage-close-up.png', 'image/png', 9000), email_id: 'em2' },
    { ...file('a-pdf', 'invoice.pdf', 'application/pdf', 4096), email_id: 'em2' }, { ...file('a-mp4', 'unboxing.mp4', 'video/mp4', 900000), email_id: 'em2' },
    { ...file('a-csv', 'items.csv', 'text/csv', 40), email_id: 'em2' }] } }
  try {
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')
    await setViewport(1440, 900)

    // List: three chips (thumbnail for images, icon otherwise) and "+3"; the full name is in the label.
    await goto('/support/emails')
    await waitFor(`document.querySelectorAll('[data-testid=mail-row-sc-mail] [data-testid=mail-attachment-chip]').length === 3`, 'attachment chips')
    assert(await evaluate(`document.querySelector('[data-testid=mail-row-attachments-more]').innerText === '+3'
      && [...document.querySelectorAll('[data-testid=mail-attachment-chip]')].map((c) => c.getAttribute('aria-label')).join('|').includes('invoice.pdf (PDF · 4.0 KB)')`), 'chip labels and +3')
    assert(rpcCalls('support_email_list_attachments').at(-1).body.p_ids.join() === 'sc-mail', 'one attachment request for the rows with files')
    await waitFor(`!!document.querySelector('[data-testid=mail-attachment-chip] img[src*="/object/sign/"]')`, 'image thumbnail on the chip')
    await screenshot('261-email-list-attachment-chips')

    // Preview from a chip: the image, next with the arrow key and the button, PDF in the viewer, Escape closes without opening the thread.
    await click('[data-testid=mail-attachment-chip]')
    await waitFor(`!!document.querySelector('[data-testid=attachment-preview-image]') && document.querySelector('[data-testid=attachment-preview]').innerText.includes('1 of 5')`, 'image preview')
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
    await waitFor(`document.querySelector('[data-testid=attachment-preview]').innerText.includes('damage-close-up.png') && document.querySelector('[data-testid=attachment-preview]').innerText.includes('2 of 5')`, 'next with the arrow key')
    await click('[data-testid=attachment-preview-next]')
    await waitFor(`!!document.querySelector('[data-testid=attachment-preview-pdf]')`, 'PDF in the viewer')
    await click('[data-testid=attachment-preview-next]')
    await click('[data-testid=attachment-preview-next]')
    await waitFor(`!!document.querySelector('[data-testid=attachment-preview-table]') && document.querySelector('[data-testid=attachment-preview-table]').innerText.includes('Basin')`, 'CSV as a table')
    await click('[data-testid=attachment-preview-prev]')
    await waitFor(`!!document.querySelector('[data-testid=attachment-preview-video], [data-testid=attachment-preview-none]')`, 'video (or a download offer when the browser cannot play it)')
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await waitFor(`!document.querySelector('[data-testid=attachment-preview]')`, 'Escape closes the preview')
    assert(!/[?&]c=/.test(await evaluate('location.search')), 'a chip click does not open the thread')

    // Thread: first email, a round "2" for the two folded ones, the unread and the last email open.
    // The row itself (its middle may be an attachment chip, which opens the preview instead).
    await evaluate(`document.querySelector('[data-testid=mail-row-sc-mail]').click()`)
    await waitFor(`!!document.querySelector('[data-testid=mail-thread-hidden]') && !!document.querySelector('[data-testid=email-em2][data-expanded=true]')`, 'thread with folded emails')
    assert(await evaluate(`document.querySelector('[data-testid=mail-thread-hidden]').innerText === '2' && !!document.querySelector('[data-testid=email-e0a][data-expanded=false]')
      && !document.querySelector('[data-testid=email-e0b]') && !!document.querySelector('[data-testid=email-em1][data-expanded=true]')`), 'folded layout')
    // Quoted reply behind "…", revealed with the original text.
    assert(await evaluate(`(() => { const b = document.querySelector('[data-testid=email-em2] [data-testid=email-body]').innerText; return b.includes('Any update') && !b.includes('checking with the warehouse') })()`), 'quote hidden')
    await click('[data-testid=email-em2] [data-testid=email-show-quoted]')
    await waitFor(`document.querySelector('[data-testid=email-em2] [data-testid=email-body]').innerText.includes('> We are checking with the warehouse.')`, 'quote shown')
    // Attachments below the email: one card each (restricted one without a link), long names in full on hover.
    assert(await evaluate(`document.querySelectorAll('[data-testid=email-em2] [data-testid=email-attachment]').length === 4
      && document.querySelectorAll('[data-testid=email-em2] [data-testid=email-attachment-restricted]').length === 1
      && !!document.querySelector('[data-testid=email-em2] [title="Quarterly damage report for the northern region.docx"]')`), 'attachment cards')
    await screenshot('262-email-thread-tools')
    // Download: a short-lived signed link that asks the browser to download (captured instead of followed).
    await evaluate(`window.__dl = []; HTMLAnchorElement.prototype.click = function () { window.__dl.push(this.href + '|' + this.download) }`)
    await evaluate(`document.querySelector('[data-testid=email-em2] [data-testid=email-attachment-download]').click()`)
    await waitFor(`window.__dl.length === 1`, 'download link')
    const dl = await evaluate('window.__dl[0]')
    assert(/\/object\/sign\/support-attachments\/.*invoice\.pdf\?token=smoke&download=invoice\.pdf\|invoice\.pdf$/.test(dl), `download link ${dl}`)
    // A docx has no preview: the viewer offers the download.
    await evaluate(`[...document.querySelectorAll('[data-testid=email-em2] [data-testid=email-attachment] > button')][3].click()`)
    await waitFor(`!!document.querySelector('[data-testid=attachment-preview-none]') && document.querySelector('[data-testid=attachment-preview-none]').innerText.includes('No preview available')`, 'download offer')
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await waitFor(`!document.querySelector('[data-testid=attachment-preview]')`, 'closed')

    // Folded emails: the "2" reveals them; Expand all / Collapse all.
    await click('[data-testid=mail-thread-hidden]')
    await waitFor(`!!document.querySelector('[data-testid=email-e0b][data-expanded=false]') && !!document.querySelector('[data-testid=email-e0c][data-expanded=false]')`, 'revealed')
    await click('[data-testid=mail-expand-all]')
    await waitFor(`document.querySelectorAll('[data-testid=email-thread] article[data-expanded=true]').length === 5`, 'all expanded')
    await click('[data-testid=mail-expand-all]')
    await waitFor(`document.querySelectorAll('[data-testid=email-thread] article[data-expanded=true]').length === 2 && !!document.querySelector('[data-testid=mail-thread-hidden]')`, 'collapsed again')

    // Each email has its own toolbar and menu; Show original reads Gmail's headers through google-gmail-send.
    assert(await evaluate(`document.querySelectorAll('[data-testid=email-menu]').length === 2 && document.querySelectorAll('[data-testid=email-toolbar]').length === 2`), 'a menu per open email')
    await click('[data-testid=email-em1] [data-testid=email-menu]')
    await waitFor(`!!document.querySelector('[data-testid=email-menu-content]')`, 'menu open')
    assert(await evaluate(bodyHasAll('Reply all', 'Forward', 'Print', 'Download message', 'Show original', 'Copy link to this email', 'Mark as unread', 'Add star', 'Report spam', 'Report phishing', 'Move to Trash')), 'menu items')
    await click('[data-testid=email-show-original]')
    await waitFor(`!!document.querySelector('[data-testid=email-original-headers]') && document.querySelector('[data-testid=email-original-headers]').innerText.includes('DKIM-Signature')`, 'original headers')
    assert(GMAIL.originalCalls.at(-1).email_id === 'em1' && GMAIL.originalCalls.at(-1).format === undefined, 'headers asked for em1 only')
    assert(await evaluate(bodyHasAll('Message ID', '<aaaa000001@customer.example>', 'PASS')), 'summary and verdicts')
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await waitFor(`!document.querySelector('[data-testid=email-original]')`, 'original closed')

    // Star one email (not the conversation).
    const convActs = MAILBOX.actions.length
    await click('[data-testid=email-em2] [data-testid=email-star]')
    for (let i = 0; i < 30 && !MAILBOX.msgActions.length; i++) await sleep(100)
    assert(MAILBOX.msgActions.at(-1).p_email === 'em2' && MAILBOX.msgActions.at(-1).p_action === 'STAR' && MAILBOX.actions.length === convActs, 'star on em2 only (not the conversation)')
    await waitFor(`!!document.querySelector('[data-testid=email-em2] [data-testid=email-star][aria-label=Starred]') && !!document.querySelector('[data-testid=email-em1] [data-testid=email-star][aria-label="Not starred"]')`, 'em2 starred, em1 not')

    // Copy link to one email, then open it: that email is shown expanded.
    await evaluate(`window.__copied = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve() } } })`)
    await click('[data-testid=email-em1] [data-testid=email-menu]')
    await click('[data-testid=email-copy-link]')
    await waitFor(`window.__copied.length === 1 && document.querySelector('[data-testid=mail-thread-info]')?.innerText === 'Link copied.'`, 'link copied')
    assert(/\/support\/emails\?c=sc-mail&m=em1$/.test(await evaluate('window.__copied[0]')), 'message link')
    await goto('/support/emails?c=sc-mail&m=e0b')
    await waitFor(`!!document.querySelector('[data-testid=email-e0b][data-expanded=true]')`, 'linked email expanded')

    // Trash asks first; Cancel does nothing.
    await click('[data-testid=email-em2] [data-testid=email-menu]')
    await click('[data-testid=email-trash]')
    await waitFor(bodyHasAll('Move this conversation to Trash?', 'Support history is never deleted'), 'trash confirmation')
    const nActs = MAILBOX.actions.length
    await click('button', 'Cancel')
    await waitFor(`!document.querySelector('[role=alertdialog]')`, 'cancelled')
    assert(MAILBOX.actions.length === nActs, 'nothing moved on cancel')
    // Report phishing asks first, records the single email and leaves the thread.
    await click('[data-testid=email-em1] [data-testid=email-menu]')
    await click('[data-testid=email-report-phishing]')
    await waitFor(bodyHasAll('Report phishing?', 'Gmail and Google are not told'), 'phishing confirmation')
    await click('[role=alertdialog] button', 'Report phishing')
    for (let i = 0; i < 30 && MAILBOX.msgActions.at(-1)?.p_action !== 'REPORT_PHISHING'; i++) await sleep(100)
    assert(MAILBOX.msgActions.at(-1).p_email === 'em1', 'phishing report for em1')
    await waitFor(`!document.querySelector('[data-testid=mail-thread]')`, 'back to the list')
    // Trash confirmed: the conversation moves to Trash.
    await goto('/support/emails?folder=all&c=sc-mail')
    await waitFor(`!!document.querySelector('[data-testid=email-em2] [data-testid=email-menu]')`, 'thread again')
    await click('[data-testid=email-em2] [data-testid=email-menu]')
    await click('[data-testid=email-trash]')
    await click('[role=alertdialog] button', 'Move to Trash')
    for (let i = 0; i < 30 && MAILBOX.actions.at(-1)?.action !== 'TRASH'; i++) await sleep(100)
    assert(MAILBOX.actions.at(-1).ids.join() === 'sc-mail', 'trash request')
    await waitFor(`!document.querySelector('[data-testid=mail-thread]')`, 'back to the list after Trash')

    // Phone: chips wrap, no horizontal scroll in the list or the thread.
    MAILBOX.state = {}
    await setViewport(390, 844)
    await goto('/support/emails?folder=all')
    await waitFor(`!!document.querySelector('[data-testid=mail-row-sc-mail] [data-testid=mail-attachment-chip]')`, 'mobile chips')
    assert(await noHorizontalScroll(), 'mobile list scrolls horizontally')
    // The row itself (its middle may be an attachment chip, which opens the preview instead).
    await evaluate(`document.querySelector('[data-testid=mail-row-sc-mail]').click()`)
    await waitFor(`!!document.querySelector('[data-testid=email-em2] [data-testid=email-attachment]')`, 'mobile thread')
    assert(await noHorizontalScroll(), 'mobile thread scrolls horizontally')
    assert(await evaluate(`[...document.querySelectorAll('[data-testid=email-menu]')].every((b) => b.getBoundingClientRect().right <= innerWidth)`), 'the email menu is on screen (not clipped)')
    await screenshot('263-email-tools-mobile')
    await cdp('Emulation.clearDeviceMetricsOverride')
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
    SUPPORT_INBOX.splice(SUPPORT_INBOX.indexOf(mailConv), 1)
    GMAIL_THREAD.splice(0, added.length)
    GMAIL_THREAD.splice(GMAIL_THREAD.indexOf(em2), 1)
    emailChannel.status = before
    MAILBOX.web = false; MAILBOX.state = {}; MAILBOX.files = {}; GMAIL.connected = false
  }
})

await step('Support WhatsApp (Meta Cloud API): Settings > WhatsApp preflight and checklist block activation, secrets never shown, statuses only from Meta, 24-hour window, approved templates only, one send per click', async () => {
  const PERMS = ['support.view', 'support.manage_tickets', 'support.assign', 'support.reply', 'support.manage_integrations', 'support.view_reports', 'support.manage_settings']
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  const waConv = supportConv('sc-wa', 'WHATSAPP', { subject: null, customer_id: 'scu1', last_message_preview: 'The basin arrived cracked' })
  SUPPORT_INBOX.push(waConv)
  const waChannel = SUPPORT_CHANNELS.find((c) => c.channel === 'WHATSAPP')
  const before = waChannel.status
  try {
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')

    // Settings: the number goes through a provider (current Zoho Bigin connection) → Migration Required; switching on is blocked.
    WA.state = 'MIGRATION_REQUIRED'; WA.enabled = false
    await goto('/support/settings?tab=whatsapp')
    await waitFor(`!!document.querySelector('[data-testid=wa-settings]') && !!document.querySelector('[data-testid=wa-secret-verify_token]')`, 'whatsapp settings')
    assert(await evaluate(`document.querySelector('[data-testid=wa-setup]').dataset.state === 'MIGRATION_REQUIRED' && document.querySelector('[data-testid=wa-enable]').disabled`), 'activation not blocked')
    assert(await evaluate(bodyHasAll('Meta Business Portfolio ID', 'WhatsApp Business Account ID', 'Phone Number ID', 'Display phone number', 'App ID', 'Graph API version',
      'Last inbound message', 'Last successful outbound message', 'Last webhook event', 'Test connection', 'WHATSAPP_APP_SECRET', 'WHATSAPP_ACCESS_TOKEN', 'Onboarding checklist',
      'Connected through a Business Solution Provider')), 'whatsapp settings content')
    await waitFor(`document.querySelector('[data-testid=wa-secret-verify_token]').innerText.includes('Not set') && document.querySelector('[data-testid=wa-secret-app_secret]').innerText.includes('Configured')`, 'secret status')
    assert(await evaluate(`document.querySelector('[data-testid=wa-webhook] code').innerText.includes('whatsapp-webhook?account=sca-wa')`), 'callback URL')
    assert(!(await evaluate(`[...document.querySelectorAll('input')].some((i) => i.type === 'password' || /secret|token/i.test(i.id))`)), 'a secret input is on the page')
    await fill('[data-testid=wa-check-migration_completed] input', 'Meta case 123, 2026-11-13')
    await click('[data-testid=wa-check-migration_completed] button[role=checkbox]')
    for (let i = 0; i < 30 && !requests.some((r) => r.path === '/rest/v1/rpc/support_whatsapp_checklist_set'); i++) await sleep(100)
    const ck = requests.filter((r) => r.path === '/rest/v1/rpc/support_whatsapp_checklist_set').at(-1)
    assert(ck && ck.body.p_key === 'migration_completed' && ck.body.p_done === true && ck.body.p_note === 'Meta case 123, 2026-11-13', `checklist request: ${JSON.stringify(ck?.body)}`)
    await click('button', 'Test connection')
    await waitFor(`document.querySelector('[data-testid=wa-settings-notice]')?.innerText.includes('on the Cloud API')`, 'test connection')
    await screenshot('250-support-whatsapp-settings')

    // Ready (Connected) → switch on.
    WA.state = 'CONNECTED'
    await goto('/support/settings?tab=whatsapp')
    await waitFor(`document.querySelector('[data-testid=wa-enable]') && !document.querySelector('[data-testid=wa-enable]').disabled`, 'enable available')
    await click('[data-testid=wa-enable]')
    await waitFor(`document.querySelector('[data-testid=wa-settings-notice]')?.innerText.includes('switched on')`, 'switched on')
    assert(WA.enabled, 'not enabled')

    // Conversation: statuses from Meta, failed reason, media to download, location, window open.
    waChannel.status = 'CONNECTED'
    WA.windowOpen = true
    await goto('/support/whatsapp?c=sc-wa')
    await waitFor(`!!document.querySelector('[data-testid=wa-panel]') && !!document.querySelector('[data-testid=wa-wm4]')`, 'whatsapp panel')
    assert(await evaluate(`document.querySelector('[data-testid=wa-wm3] [data-testid=wa-status]').dataset.status === 'READ' && document.querySelector('[data-testid=wa-wm4] [data-testid=wa-status]').dataset.status === 'FAILED'`), 'statuses')
    assert(await evaluate(bodyHasAll('Message undeliverable (131026)', 'Media not downloaded yet.', 'Site, Mumbai', 'Customer service window open')), 'panel content')
    assert(await evaluate(`document.querySelector('[data-testid=wa-window]').dataset.open === 'true'`), 'window flag')
    // Send text: three fast clicks, one request; shown as Pending (accepted by Meta), not Sent.
    const n0 = WA.sendCalls.length
    await fill('[data-testid=wa-composer] textarea', 'A replacement leaves today.')
    await evaluate(`(() => { const b = document.querySelector('[data-testid=wa-send]'); b.click(); b.click(); b.click() })()`)
    await waitFor(`document.querySelector('[data-testid=wa-notice]')?.innerText.includes('Accepted by Meta')`, 'accepted notice')
    await sleep(400)
    assert(WA.sendCalls.length - n0 === 1, `repeated clicks sent ${WA.sendCalls.length - n0} requests`)
    const req = WA.sendCalls.at(-1)
    assert(req.kind === 'TEXT' && req.conversation_id === 'sc-wa' && req.text === 'A replacement leaves today.' && /^[0-9a-f-]{36}$/.test(req.idempotency_key), `send request: ${JSON.stringify(req)}`)
    assert(!(await evaluate(`document.querySelector('[data-testid=wa-notice]').innerText.includes('Sent:')`)), 'shown as sent')
    await screenshot('251-support-whatsapp-conversation')

    // Window closed: no free-form composer, only an approved template.
    WA.windowOpen = false
    await goto('/support/whatsapp?c=sc-wa')
    await waitFor(`document.querySelector('[data-testid=wa-window]')?.dataset.open === 'false' && !!document.querySelector('[data-testid=wa-template-open]')`, 'window closed')
    assert(!(await evaluate(`!!document.querySelector('[data-testid=wa-send]')`)), 'free-form send offered outside the window')
    await click('[data-testid=wa-template-open]')
    await waitFor(`!!document.querySelector('[data-testid=wa-template-dialog]')`, 'template dialog')
    await choose('#wa-tpl', 'order_update')
    await waitFor(`!!document.querySelector('#wa-v-1') && !!document.querySelector('#wa-v-2')`, 'placeholders')
    await fill('#wa-v-1', 'Ravi')
    await click('[data-testid=wa-template-send]')
    await waitFor(bodyHas('Enter values for {{2}}'), 'missing value refused')
    await fill('#wa-v-2', 'SO-000011')
    await waitFor(`document.querySelector('[data-testid=wa-template-preview]').innerText.includes('Hi Ravi, your order SO-000011 is on its way.')`, 'preview')
    await click('[data-testid=wa-template-send]')
    await waitFor(`document.querySelector('[data-testid=wa-notice]')?.innerText.includes('Accepted by Meta')`, 'template accepted')
    const tr = WA.templateCalls.at(-1)
    assert(tr.kind === 'TEMPLATE' && tr.template_id === 'wt1' && tr.parameters['1'] === 'Ravi' && tr.parameters['2'] === 'SO-000011' && tr.conversation_id === 'sc-wa', `template request: ${JSON.stringify(tr)}`)
    await screenshot('252-support-whatsapp-template')

    // New conversation from the WhatsApp page: template to a number.
    await goto('/support/whatsapp')
    await waitFor(`!!document.querySelector('[data-testid=wa-start]')`, 'start conversation')
    await click('[data-testid=wa-start]')
    await waitFor(`!!document.querySelector('#wa-to')`, 'number field')
    await fill('#wa-to', '+91 99887 76655')
    await choose('#wa-tpl', 'order_update')
    await fill('#wa-v-1', 'A')
    await fill('#wa-v-2', 'B')
    await click('[data-testid=wa-template-send]')
    for (let i = 0; i < 30 && WA.templateCalls.at(-1)?.to !== '+91 99887 76655'; i++) await sleep(100)
    assert(WA.templateCalls.at(-1).to === '+91 99887 76655' && !WA.templateCalls.at(-1).conversation_id, 'start conversation request')
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
    SUPPORT_INBOX.splice(SUPPORT_INBOX.indexOf(waConv), 1)
    waChannel.status = before
    WA.enabled = false; WA.state = 'MIGRATION_REQUIRED'; WA.windowOpen = true
  }
})

await step('WhatsApp Web screen: three panels, filters and pins, ticks only from Meta, emoji + Enter to send, reply, safe retry, message info, notes never sent, ticket / customer views, phone layout', async () => {
  const PERMS = ['support.view', 'support.manage_tickets', 'support.assign', 'support.reply', 'support.manage_integrations']
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  const waConv = supportConv('sc-wa', 'WHATSAPP', { subject: null, customer_id: 'scu1', last_message_preview: 'Are you there?', unread_count: 1 })
  SUPPORT_INBOX.push(waConv)
  const waChannel = SUPPORT_CHANNELS.find((c) => c.channel === 'WHATSAPP')
  const before = waChannel.status
  WA.web = true; WA.enabled = true; WA.state = 'CONNECTED'; WA.windowOpen = true; WA.prefs = {}; waChannel.status = 'CONNECTED'
  try {
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')
    await setViewport(1440, 900)

    // List: WhatsApp-only list from the server, filters, Groups disabled, connection shown.
    await goto('/support/whatsapp')
    await waitFor(`!!document.querySelector('[data-testid=wa-web] [data-testid=inbox-list]') && !!document.querySelector('[data-testid=conversation-sc-wa]')`, 'conversation list')
    assert(rpcCalls('support_whatsapp_inbox').at(-1).body.p_view === 'ALL', 'list from support_whatsapp_inbox')
    assert(await evaluate(`document.querySelector('[data-testid=wa-filter-GROUPS]').disabled && document.querySelector('[data-testid=wa-setup-state]').innerText.includes('WhatsApp on')`), 'groups disabled / connection')
    assert(await evaluate(`!!document.querySelector('[data-testid=wa-empty]')`), 'empty state before a chat is chosen')
    await click('[data-testid=wa-filter-UNREAD]')
    for (let i = 0; i < 30 && rpcCalls('support_whatsapp_inbox').at(-1)?.body.p_view !== 'UNREAD'; i++) await sleep(100)
    assert(rpcCalls('support_whatsapp_inbox').at(-1).body.p_view === 'UNREAD', 'unread filter on the server')
    await click('[data-testid=wa-filter-ALL]')
    // Context menu: pin (personal preference through the server), shown with a pin and listed first.
    await waitFor(`!!document.querySelector('[data-testid=conversation-sc-wa]')`, 'row')
    await evaluate(`document.querySelector('[data-testid=conversation-sc-wa]').closest('li').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }))`)
    await waitFor(`[...document.querySelectorAll('[role=menuitem]')].some((e) => e.innerText.includes('Pin chat'))`, 'context menu')
    await click('[role=menuitem]', 'Pin chat')
    await waitFor(`!!document.querySelector('[data-testid=conversation-sc-wa] [aria-label=Pinned]')`, 'pinned')
    assert(WA.prefCalls.at(-1).p_conversation === 'sc-wa' && WA.prefCalls.at(-1).p_pinned === true, `pin request ${JSON.stringify(WA.prefCalls.at(-1))}`)
    assert(await evaluate(`document.querySelector('[data-testid=inbox-list] [data-wa-row]').dataset.testid === 'conversation-sc-wa'`), 'pinned first')
    // List tick of the last outbound message comes from its status, never "read" by default.
    assert(await evaluate(`document.querySelector('[data-testid=conversation-sc-wa] [data-testid=wa-status]').dataset.tick === 'FAILED'
      && document.querySelector('[data-testid=conversation-sc1] [data-testid=wa-status]').dataset.tick === 'READ'`), 'list ticks')

    // Chat: three panels on desktop, date separator, ticks, failure with Meta's code, media download prompt, location.
    await click('[data-testid=conversation-sc-wa]')
    await waitFor(`!!document.querySelector('[data-testid=wa-panel]') && !!document.querySelector('[data-testid=wa-wm4]')`, 'chat')
    await waitFor(`!!document.querySelector('[data-testid=wa-info]')`, 'contact drawer open on desktop')
    assert(await evaluate(`[...document.querySelectorAll('[data-testid=wa-day]')].some((d) => d.innerText === 'TODAY')`), 'date separator')
    assert(await evaluate(`document.querySelector('[data-testid=wa-wm3] [data-testid=wa-status]').dataset.tick === 'READ' && document.querySelector('[data-testid=wa-wm4] [data-testid=wa-status]').dataset.tick === 'FAILED'
      && !document.querySelector('[data-testid=wa-wm1] [data-testid=wa-status]')`), 'ticks only on outgoing, from the status')
    assert(await evaluate(bodyHasAll('Message undeliverable (131026)', 'Media not downloaded yet.', 'Site, Mumbai', 'Customer service window open')), 'chat content')
    assert(await evaluate(`!!document.querySelector('[data-testid=wa-wm3] [data-testid=wa-quote]')`), 'reply preview on the quoted message')
    for (let i = 0; i < 30 && rpcCalls('support_conversation_mark_read').at(-1)?.body.p_id !== 'sc-wa'; i++) await sleep(100)
    assert(rpcCalls('support_conversation_mark_read').at(-1)?.body.p_id === 'sc-wa', 'opening marks the conversation read')
    await screenshot('256-whatsapp-web-desktop')

    // Emoji picker inserts at the caret; Shift+Enter does not send; Enter sends once.
    const n0 = WA.sendCalls.length
    await fill('[data-testid=wa-composer] textarea', 'Replacement leaves today ')
    await click('[data-testid=wa-emoji]')
    await waitFor(`!!document.querySelector('[data-testid=wa-emoji-picker]')`, 'emoji picker')
    await fill('[data-testid=wa-emoji-search]', 'thumbs up')
    await waitFor(`!!document.querySelector('[data-testid=wa-emoji-picker] button[data-emoji="\u{1F44D}"]')`, 'emoji search')
    await click('[data-testid=wa-emoji-picker] button[data-emoji="\u{1F44D}"]')
    await waitFor(`document.querySelector('[data-testid=wa-composer] textarea').value === 'Replacement leaves today \u{1F44D}'`, 'emoji inserted')
    await evaluate(`document.querySelector('[data-testid=wa-composer] textarea').focus()`)
    for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 })
    await sleep(400)
    assert(WA.sendCalls.length === n0, 'Shift+Enter sent the message')
    await press('[data-testid=wa-composer] textarea', 'Enter')
    await waitFor(`document.querySelector('[data-testid=wa-notice]')?.innerText.includes('Accepted by Meta')`, 'sent with Enter')
    assert(WA.sendCalls.length - n0 === 1 && WA.sendCalls.at(-1).text === 'Replacement leaves today \u{1F44D}', `enter send ${JSON.stringify(WA.sendCalls.at(-1))}`)

    // Reply to a message: preview, cancel button, reply_to sent. Unsupported actions are disabled.
    await evaluate(`document.querySelector('[data-testid=wa-wm1] button[aria-label="Message options"]').style.opacity = '1'`)
    await click('[data-testid=wa-wm1] button[aria-label="Message options"]')
    await waitFor(`[...document.querySelectorAll('[role=menuitem]')].some((e) => e.innerText.includes('Reply'))`, 'message menu')
    assert(await evaluate(`[...document.querySelectorAll('[role=menuitem]')].filter((e) => /React|Forward|Delete/.test(e.innerText)).length === 3
      && [...document.querySelectorAll('[role=menuitem]')].filter((e) => /React|Forward|Delete/.test(e.innerText)).every((e) => e.hasAttribute('data-disabled'))`), 'unsupported actions disabled')
    await click('[role=menuitem]', 'Reply')
    await waitFor(`document.querySelector('[data-testid=wa-reply-preview]')?.innerText.includes('The basin arrived cracked')`, 'reply preview')
    await fill('[data-testid=wa-composer] textarea', 'Sorry about that')
    await click('[data-testid=wa-send]')
    for (let i = 0; i < 30 && WA.sendCalls.at(-1)?.text !== 'Sorry about that'; i++) await sleep(100)
    assert(WA.sendCalls.at(-1).reply_to === 'wm1', `reply_to ${JSON.stringify(WA.sendCalls.at(-1))}`)
    await waitFor(`!document.querySelector('[data-testid=wa-reply-preview]')`, 'reply preview cleared')

    // Safe retry: only the message Meta reported FAILED; a new message with a new key, offered once.
    const keys = new Set(WA.sendCalls.map((c) => c.idempotency_key))
    await click('[data-testid=wa-wm4] [data-testid=wa-retry]')
    for (let i = 0; i < 30 && WA.sendCalls.at(-1)?.text !== 'Are you there?'; i++) await sleep(100)
    assert(WA.sendCalls.at(-1).text === 'Are you there?' && !keys.has(WA.sendCalls.at(-1).idempotency_key), `retry is a new request: ${JSON.stringify(WA.sendCalls.at(-1))}`)
    await waitFor(`!document.querySelector('[data-testid=wa-wm4] [data-testid=wa-retry]')`, 'retry offered once')
    assert(!(await evaluate(`!!document.querySelector('[data-testid=wa-wm3] [data-testid=wa-retry]')`)), 'retry offered on a read message')

    // Message info: receipt times as Meta reported them.
    await evaluate(`document.querySelector('[data-testid=wa-wm3] button[aria-label="Message options"]').style.opacity = '1'`)
    await click('[data-testid=wa-wm3] button[aria-label="Message options"]')
    await waitFor(`[...document.querySelectorAll('[role=menuitem]')].some((e) => e.innerText.includes('Message info'))`, 'menu')
    await click('[role=menuitem]', 'Message info')
    await waitFor(`!!document.querySelector('[data-testid=wa-info-read]') && !document.querySelector('[data-testid=wa-info-read]').innerText.includes('Not reported')`, 'message info')
    assert(rpcCalls('support_whatsapp_message_info').at(-1).body.p_id === 'wm3', 'message info request')
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await waitFor(`!document.querySelector('[data-testid=wa-message-info]')`, 'closed')

    // Search inside the conversation.
    await click('[data-testid=wa-search-toggle]')
    await fill('[data-testid=wa-search] input', 'CRACKED')
    await waitFor(`document.querySelector('[data-testid=wa-search]').innerText.includes('1 of 1') && !!document.querySelector('[data-testid=wa-wm1] mark')`, 'search hit')

    // Internal note: saved as a note, never sent on WhatsApp.
    const sends = WA.sendCalls.length
    await fill('[data-testid=wa-note-input]', 'Customer prefers morning calls')
    await click('[data-testid=wa-note-add]')
    for (let i = 0; i < 30 && rpcCalls('support_note_add').at(-1)?.body.p_body !== 'Customer prefers morning calls'; i++) await sleep(100)
    assert(rpcCalls('support_note_add').at(-1).body.p_target === 'CONVERSATION' && WA.sendCalls.length === sends, 'note not sent to WhatsApp')
    assert(await evaluate(bodyHasAll('never sent to the customer on WhatsApp', 'Checked stock for a replacement')), 'notes listed and labelled')

    // Ticket and customer views.
    await click('[data-testid=wa-view-ticket]')
    await waitFor(`!!document.querySelector('[data-testid=wa-pane-ticket] [data-testid=create-ticket-from-conversation]')`, 'ticket view')
    await click('[data-testid=wa-view-customer]')
    await waitFor(`!!document.querySelector('[data-testid=wa-pane-customer] [data-testid=wa-erp-customer]')`, 'customer view')
    await click('[data-testid=wa-view-chat]')
    await waitFor(`!!document.querySelector('[data-testid=wa-messages]')`, 'back to chat')

    // Window closes: no free-form composer any more, approved template only (picked up by polling).
    WA.windowOpen = false
    await waitFor(`document.querySelector('[data-testid=wa-window]')?.dataset.open === 'false' && !!document.querySelector('[data-testid=wa-template-open]') && !document.querySelector('[data-testid=wa-send]')`, 'window closed (polled)', 15000)
    WA.windowOpen = true

    // Phone: list first, then the chat full screen with a back button; no horizontal scroll.
    await setViewport(390, 844)
    await goto('/support/whatsapp')
    await waitFor(`!!document.querySelector('[data-testid=conversation-sc-wa]')`, 'mobile list')
    assert(await noHorizontalScroll(), 'mobile list scrolls horizontally')
    await click('[data-testid=conversation-sc-wa]')
    await waitFor(`!!document.querySelector('[data-testid=wa-panel]') && document.querySelector('[data-testid=wa-panel]').getBoundingClientRect().width >= 380`, 'mobile chat full screen')
    assert(await noHorizontalScroll(), 'mobile chat scrolls horizontally')
    await screenshot('257-whatsapp-web-mobile')
    await click('button[aria-label="Back to conversations"]')
    await waitFor(`!document.querySelector('[data-testid=wa-panel]') && !!document.querySelector('[data-testid=conversation-sc-wa]')`, 'back to list')
    await cdp('Emulation.clearDeviceMetricsOverride')
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
    SUPPORT_INBOX.splice(SUPPORT_INBOX.indexOf(waConv), 1)
    waChannel.status = before
    WA.web = false; WA.enabled = false; WA.state = 'MIGRATION_REQUIRED'; WA.windowOpen = true; WA.prefs = {}
  }
})

await step('Support unified: ticket rules, business hours and escalation, integration health (Connected only after a real test, expired credentials), ticket SLA panel, reports with CSV export', async () => {
  const PERMS = ['support.view', 'support.manage_tickets', 'support.assign', 'support.reply', 'support.manage_integrations', 'support.view_reports', 'support.manage_settings']
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  try {
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')

    // Ticket rules: switch on missed-call tickets and WhatsApp keywords; the saved rules reach the server.
    await goto('/support/settings?tab=rules')
    await waitFor(`!!document.querySelector('[data-testid=ticket-rules]') && !!document.querySelector('[data-testid=assignment-rules]')`, 'ticket rules')
    assert(await evaluate(bodyHasAll('Ticket only when an agent creates one', 'Create a ticket for every missed call', 'Reopen a resolved ticket when the customer replies',
      'Escalate breached tickets', 'Agent and department assignment', 'Urgent to quality')), 'rules content')
    await click('[data-testid=rule-missed_call_enabled]')
    await waitFor(`document.querySelector('[data-testid=rule-missed_call_enabled]').getAttribute('aria-checked') === 'true'`, 'missed-call rule ticked')
    await click('[data-testid=rule-whatsapp_keywords_enabled]')
    await fill('#rule-wk', 'damaged, urgent')
    await click('[data-testid=rules-save]')
    await waitFor(`document.querySelector('[data-testid=unified-notice]')?.innerText.includes('Ticket rules saved')`, 'rules saved')
    const saved = UNI.rulesSaves.at(-1)
    assert(saved.missed_call_enabled === true && saved.whatsapp_keywords_enabled === true && JSON.stringify(saved.whatsapp_keywords) === '["damaged","urgent"]', `rules: ${JSON.stringify(saved)}`)
    await screenshot('260-support-ticket-rules')

    // SLA: business hours, holidays, escalation levels; run the monitor now.
    await goto('/support/settings?tab=sla')
    await waitFor(`!!document.querySelector('[data-testid=sla-calendar]') && !!document.querySelector('[data-testid=escalation-levels]')`, 'sla calendar')
    assert(await evaluate(bodyHasAll('Business hours', 'Pause the SLA while a ticket waits for the customer', 'Test holiday', 'Escalations')), 'calendar content')
    await click('[data-testid=cal-enabled]')
    await click('[data-testid=cal-save]')
    await waitFor(`document.querySelector('[data-testid=unified-notice]')?.innerText.includes('Business hours saved')`, 'calendar saved')
    assert(UNI.calendarSaves.at(-1).enabled === true && UNI.calendarSaves.at(-1).start_time === '09:30', `calendar: ${JSON.stringify(UNI.calendarSaves.at(-1))}`)
    await click('button', 'Run SLA check now')
    await waitFor(`document.querySelector('[data-testid=unified-notice]')?.innerText.includes('1 breaches')`, 'sla run')

    // Integration health: per provider, honest statuses, expired credentials, failed events, retry queue, test.
    await goto('/support/settings?tab=health')
    await waitFor(`!!document.querySelector('[data-testid=health-META_WHATSAPP]')`, 'integration health')
    assert(await evaluate(`document.querySelector('[data-testid=health-ACEFONE]').innerText.includes('Verified by API test: Never')
      && !document.querySelector('[data-testid=health-ACEFONE]').innerText.includes('Connected')`), 'untested provider shown as connected')
    assert(await evaluate(`!!document.querySelector('[data-testid=health-expired-GOOGLE_WORKSPACE]')`), 'expired credentials')
    assert(await evaluate(bodyHasAll('Last webhook received', 'Last successful outbound', 'Failed events (7 days)', 'Retry queue', 'Signature rejected')), 'health content')
    await click('[data-testid=health-ACEFONE] button', 'Test connection')
    await waitFor(`!!document.querySelector('[data-testid=unified-notice]')`, 'provider test result')
    await screenshot('261-support-integration-health')

    // Ticket SLA panel: remaining time, breach, escalation history.
    await goto('/support/tickets/st1')
    await waitFor(`!!document.querySelector('[data-testid=ticket-sla]')`, 'ticket sla')
    assert(await evaluate(`document.querySelector('[data-testid=ticket-sla]').innerText.includes('45 min overdue') && document.querySelector('[data-testid=ticket-sla]').innerText.includes('2 h 30 min left')
      && document.querySelector('[data-testid=ticket-sla-history]').innerText.includes('Escalated (level 1)') && document.querySelector('[data-testid=ticket-sla]').innerText.includes('30 minutes excluded')`), 'sla panel content')

    // Reports: unified sections with CSV export.
    await goto('/support/reports')
    await waitFor(`!!document.querySelector('[data-testid=unified-reports]') && !!document.querySelector('[data-testid=report-sla]')`, 'unified reports')
    assert(await evaluate(bodyHasAll('Channel-wise incoming volume', 'Calls: answer and missed rates', 'Email and WhatsApp response time', 'Ticket volume and closure rate', 'Agent workload',
      'SLA compliance', 'Customer satisfaction')), 'report sections')
    const r = rpcCalls('support_reports_unified').at(-1)
    assert(r && /^\d{4}-\d{2}-\d{2}$/.test(r.body.p_from) && /^\d{4}-\d{2}-\d{2}$/.test(r.body.p_to), 'date filter sent')
    await click('[data-testid=csv-calls]')
    await screenshot('262-support-unified-reports')
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
  }
})

await step('Acefone agent telephony and softphone: agent extension settings, softphone status never "Connected", official AceConnect links, call notes / ticket link / previous interactions, telephony analytics', async () => {
  const PERMS = ['support.view', 'support.manage_tickets', 'support.assign', 'support.reply', 'support.manage_integrations', 'support.view_reports', 'support.manage_settings']
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  try {
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')

    // Agent telephony settings
    await goto('/support/settings?tab=phone')
    await waitFor(`!!document.querySelector('[data-testid=phone-lines]')`, 'agent telephony table')
    assert(await evaluate(bodyHasAllCI('Agent telephony settings', 'ERP agent', 'Extension number', 'Acefone extension id', 'Display caller id', 'Availability', 'Softphone setup',
      'Acefone agent status', '7001', '08069411111', 'Instructions sent', 'Extension passwords are never stored here')), 'agent telephony columns')
    await click('button', 'Read agent status from Acefone')
    await waitFor(`document.querySelector('[data-testid=phone-notice]')?.innerText.includes('lines matched')`, 'agent status read')
    assert(SOFT.agentsReads === 1, 'agents action not called')
    await click('[data-testid=phone-lines] button', 'Edit')
    await waitFor(`!!document.querySelector('#ln-ext') && document.querySelector('#ln-cid').value === '08069411111'`, 'line dialog with telephony fields')
    assert(!(await evaluate(`[...document.querySelectorAll('[role=dialog] input')].some((i) => i.type === 'password' || /password/i.test(i.id))`)), 'password field in line dialog')
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await screenshot('270-acefone-agent-telephony')

    // Softphone status widget: not "Connected" without a provider signal; official links; no answer button.
    await goto('/support/calls')
    await waitFor(`!!document.querySelector('[data-testid=softphone-widget]')`, 'softphone widget')
    assert(await evaluate(`document.querySelector('[data-testid=softphone-widget]').dataset.state === 'NOT_VERIFIED' && !document.querySelector('[data-testid=softphone-widget]').innerText.includes('Connected')`), 'softphone state')
    await click('[data-testid=softphone-widget]')
    await waitFor(`!!document.querySelector('[data-testid=softphone-dialog]')`, 'softphone dialog')
    assert(await evaluate(`document.querySelector('[data-testid=softphone-dialog]').innerText.includes('0601234567') && document.querySelector('[data-testid=softphone-dialog]').innerText.includes('answer them in AceConnect')
      && [...document.querySelectorAll('[data-testid=aceconnect-links] a')].length === 5 && [...document.querySelectorAll('[data-testid=aceconnect-links] a')].every((a) => a.rel.includes('noopener') && a.href.startsWith('https://'))`), 'softphone dialog content')
    assert(!(await evaluate(`[...document.querySelectorAll('button')].some((b) => /^\\s*answer\\s*$/i.test(b.innerText))`)), 'fake Answer button')
    await screenshot('271-acefone-softphone')
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })

    // After the call: note, previous interactions, link to an open ticket.
    await goto('/support/calls/call1')
    await waitFor(`!!document.querySelector('[data-testid=call-follow-up]') && !!document.querySelector('[data-testid=call-previous]')`, 'call follow-up')
    await fill('[data-testid=call-follow-up] textarea', 'Customer wants a replacement basin.')
    await click('[data-testid=call-note-save]')
    await waitFor(`document.querySelector('[data-testid=call-follow-up-msg]')?.innerText.includes('Note saved') && document.querySelector('[data-testid=call-notes]')?.innerText.includes('replacement basin')`, 'note saved')
    await click('[data-testid=call-follow-up] button', 'Link')
    await waitFor(`document.querySelector('[data-testid=call-follow-up-msg]')?.innerText.includes('Linked to TKT-000001')`, 'ticket linked')
    assert(SOFT.links.at(-1)[0] === 'call1' && SOFT.links.at(-1)[1] === 'st1', 'link request')
    assert(await evaluate(`document.querySelector('[data-testid=call-previous]').innerText.includes('Cracked basin')`), 'previous interactions')

    // Telephony analytics
    await goto('/support/calls?tab=analytics')
    await waitFor(`!!document.querySelector('[data-testid=call-analytics]') && !!document.querySelector('[data-testid=call-customers]')`, 'call analytics')
    assert(await evaluate(bodyHasAll('Inbound calls', 'Outbound calls', 'Answered', 'Missed', 'Failed', 'Average call duration', 'Average answer time', 'Agent-wise calls',
      'Customer-wise call history', 'Unknown caller', 'Unconfirmed requests')), 'analytics content')
    await choose('[aria-label="Group by"]', 'Weekly')
    for (let i = 0; i < 30 && rpcCalls('support_call_analytics').at(-1)?.body.p_group !== 'week'; i++) await sleep(100)
    assert(rpcCalls('support_call_analytics').at(-1).body.p_group === 'week', 'weekly grouping sent')
    await screenshot('272-acefone-call-analytics')
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
  }
})

await step('Bulk BOM management: six BOM tabs, where-used search, bulk replace preview with impact, submit / approve / publish, revision history, Excel change-file validation', async () => {
  await goto('/production/boms')
  await waitFor(`!!document.querySelector('[data-testid=bom-tabs]')`, 'BOM tabs')
  assert(await evaluate(`(() => { const t = document.querySelector('[data-testid=bom-tabs]').innerText; return ['BOM Master', 'Where-Used Analysis', 'Bulk BOM Editor', 'Revision History', 'Change Approvals', 'Excel Import/Export'].every((x) => t.includes(x)) })()`), 'six tabs')
  await waitFor(bodyHas('BOM-000001'), 'BOM master list still shown')
  // One row per finished product: the approved version only; "Show all versions" brings back the pending v2.
  await goto('/production/boms?status=ALL')
  await waitFor(`!!document.querySelector('[data-testid=bom-cost-bom1]')`, 'latest approved version listed')
  assert(!(await evaluate(`!!document.querySelector('[data-testid=bom-cost-bom2]')`)), 'older / other versions of the same product must be hidden by default')
  await click('[data-testid=bom-all-versions] button')
  await waitFor(`!!document.querySelector('[data-testid=bom-cost-bom2]') && location.search.includes('versions=all')`, 'all versions shown')
  await goto('/production/boms')
  await waitFor(`!!document.querySelector('[data-testid=bom-tabs]')`, 'BOM tabs')

  // Where-used
  await click('[data-testid=bom-tabs] button', 'Where-Used Analysis')
  await waitFor(`!!document.querySelector('[data-testid=where-used]') && location.search.includes('tab=where-used')`, 'where-used tab')
  await fill('[data-testid=where-used-component] input', 'glaze')
  await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('RM-GLAZE-01'))`, 'component hits')
  await click('[role=option]', 'RM-GLAZE-01')
  await waitFor(`document.querySelector('[data-testid=where-used-table]')?.innerText.includes('FG-BASIN-3')`, 'where-used rows')
  assert(await evaluate(bodyHasAllCI('Finished product', 'BOM / revision', 'Quantity', 'UOM', 'Wastage %', 'Status', 'Effective', 'BOM-000101', '3 current revisions')), 'where-used columns')
  assert(rpcCalls('bom_where_used').at(-1).body.p_filters.status === 'CURRENT', 'current revisions by default')
  await screenshot('280-bom-where-used')

  // Bulk replace
  assert(!(await evaluate(`[...document.querySelectorAll('[data-testid=where-used] button')].some((b) => b.innerText.trim() === 'Edit')`)), 'no Edit shortcut on where-used')
  await click('main button', 'Replace')
  await waitFor(`location.search.includes('tab=editor') && location.search.includes('op=REPLACE') && document.querySelector('[data-testid=bulk-old-component]')?.innerText.includes('RM-GLAZE-01')`, 'editor with the component')
  await waitFor(`document.querySelector('[data-testid=bulk-bom-table]')?.innerText.includes('FG-BASIN-2')`, 'BOMs to change')
  assert(!(await evaluate(`[...document.querySelectorAll('[aria-label="Bulk operation"] button')].some((b) => /bulk edit/i.test(b.innerText))`)), 'Bulk edit must not be offered in the editor')
  await fill('[data-testid=bulk-new-component] input', 'glaze-02')
  await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('RM-GLAZE-02'))`, 'replacement hits')
  await click('[role=option]', 'RM-GLAZE-02')
  await click('[aria-label="Select all BOMs"]')
  await waitFor(`document.querySelector('[data-testid=bulk-selected-count]')?.innerText.startsWith('3')`, 'all selected')
  await fill('#bulk-reason', 'Supplier changed the glaze')
  await waitFor(`!document.querySelector('[data-testid=bulk-preview]').disabled`, 'preview enabled')
  await screenshot('281-bom-bulk-editor')
  await click('[data-testid=bulk-preview]')
  await waitFor(`!!document.querySelector('[data-testid=batch-detail]') && location.search.includes('batch=bcb1')`, 'batch preview')
  const sent = BULK.saves.at(-1)
  assert(sent.p_header.operation === 'REPLACE' && sent.p_lines.length === 3 && sent.p_lines.every((l) => l.new_component_product_id === 'cmp-new' && l.component_product_id === 'cmp-old' && !('quantity' in l)), JSON.stringify(sent))
  assert(await evaluate(bodyHasAllCI('BOMs affected', 'Component lines', 'Lines with errors', 'Production orders potentially affected', 'PRD-000001', 'Keeps v1',
    'Inventory and procurement impact', 'RM-GLAZE-01: 40 KG available, 25 KG on open purchase orders', '1.5 KG → 1.5 KG')), 'preview and impact')

  // Workflow
  for (const [button, status] of [['batch-submit', 'PENDING_APPROVAL'], ['batch-approve', 'APPROVED'], ['batch-publish', 'PUBLISHED']]) {
    await click(`[data-testid=${button}]`)
    await waitFor(`!!document.querySelector('[data-testid=batch-confirm]')`, `${button} dialog`)
    await click('[data-testid=batch-confirm]')
    await waitFor(`document.querySelector('[data-testid=batch-detail]')?.dataset.status === '${status}'`, status)
  }
  await waitFor(`document.querySelector('[data-testid=batch-message]')?.innerText.includes('Published: 3 new BOM revision')`, 'published message')
  assert(BULK.published === 1 && rpcCalls('bom_change_batch_publish').length === 1 && /^[0-9a-f-]{36}$/.test(rpcCalls('bom_change_batch_publish')[0].body.p_idempotency_key), 'one publish with a request id')
  assert(await evaluate(bodyHasAllCI('Created', 'Submitted for approval', 'Approved', 'Published', 'Create reversal')), 'history and reversal')
  await screenshot('282-bom-batch-published')

  // Approvals list and revision history
  await click('main button', 'All batches')
  await waitFor(`document.querySelector('[data-testid=bom-batches]')?.innerText.includes('BCB-000001') || document.querySelector('[data-testid=bom-approvals]')?.innerText.includes('No batches here')`, 'batch list')
  await goto('/production/boms?tab=revisions&rsource=BULK')
  await waitFor(`document.querySelector('[data-testid=bom-revision-table]')?.innerText.includes('BCB-000001')`, 'revision history')
  assert(await evaluate(bodyHasAllCI('Compare with previous', 'Supplier changed the glaze')), 'revision row')

  // Excel change file: row-level validation
  await goto('/production/boms?tab=excel')
  await waitFor(`!!document.querySelector('[data-testid=bom-import-export]')`, 'excel tab')
  const csv = path.join(outDir, 'bom-bulk-add.csv')
  writeFileSync(csv, 'Finished Product SKU,Component SKU,Quantity,Unit,Wastage %,Notes\nFG-BASIN-1,PK-BOX-01,1,PCS,0,carton\nFG-UNKNOWN,PK-BOX-01,1,,,\nFG-BASIN-1,PK-BOX-01,-2,,,\n')
  await setFile(csv)
  await waitFor(`document.querySelector('[data-testid=bom-import-summary]')?.innerText.includes('1 valid row')`, 'validated rows')
  assert(await evaluate(bodyHasAllCI('2 with errors', 'FG-UNKNOWN is not in the Product Master', 'greater than zero')), 'row errors')
  await fill('#import-reason', 'Add outer carton')
  await click('[data-testid=bom-import-create]')
  await waitFor(`!!document.querySelector('[data-testid=batch-detail]') && location.search.includes('batch=bcb2')`, 'draft from Excel')
  assert(BULK.saves.at(-1).p_header.operation === 'ADD' && BULK.saves.at(-1).p_lines.length === 1 && BULK.saves.at(-1).p_lines[0].finished_product_id === 'fgb1', JSON.stringify(BULK.saves.at(-1)))
  await screenshot('283-bom-excel-import')
})

await step('WhatsApp activation preflight: one server gate for status, eligibility and Switch on; Meta-verified checks; exact block reasons; delivery not inferred', async () => {
  const PERMS = ['support.view', 'support.manage_integrations', 'support.reply']
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  const chk = (key, label, result, source, detail, mandatory = true) => ({ key, label, result, source, detail, mandatory })
  const READY = [chk('identifiers', 'Meta identifiers and Graph API version entered', 'OK', 'CONFIG', 'WABA 1973917729842030, phone number id 1425662810634514.'),
    chk('connection_test', 'Connection test passed', 'OK', 'TEST', 'Connected: Alton India +91 1800 123 9722 on the Cloud API, quality GREEN.'),
    chk('phone_in_waba', 'The phone number id belongs to the configured WhatsApp Business Account', 'OK', 'META', 'Meta lists phone number id 1425662810634514 under WABA 1973917729842030.'),
    chk('business_portfolio', 'The WhatsApp Business Account belongs to the configured business portfolio', 'OK', 'META', 'Meta: WABA owned by portfolio 3489020898058707.'),
    chk('cloud_api_eligibility', 'Number registered and active on the Cloud API under this WABA', 'OK', 'META', 'Verified by Meta: CONNECTED on CLOUD_API, quality GREEN.'),
    chk('access_token', 'Permanent system-user token with whatsapp_business_messaging and whatsapp_business_management', 'OK', 'META', 'Verified by Meta: valid system_user token, never expires.'),
    chk('webhook_subscription', 'The Meta app is subscribed to this WABA webhooks', 'OK', 'META', 'Verified by Meta: app 1684047306664863 is subscribed.'),
    chk('webhook_verified', 'Webhook callback verified (challenge)', 'OK', 'WEBHOOK', 'Challenge passed.'),
    chk('webhook_signed', 'A correctly signed webhook event received', 'OK', 'WEBHOOK', 'Last signed event received.'),
    chk('quality_rating', 'Phone quality rating', 'OK', 'TEST', 'Meta: GREEN.', false)]
  const delivery = { inbound_messages: 0, last_inbound_at: null, outbound_accepted: 0, outbound_delivered: 0, outbound_read: 0, outbound_failed: 0, status_callbacks: 0,
    last_outbound_success_at: null, inbound_proven: false, outbound_proven: false }
  let mode = 'blocked'
  const BLOCK = 'Phone number id 1425662810634514 is NOT under WABA 1973917729842030 according to Meta (1 other number(s) found).'
  WA.preflight = () => (mode === 'ready'
    ? { status: WA.enabled ? 'ACTIVE' : 'READY_TO_ACTIVATE', setup_state: 'CONNECTED', can_activate: !WA.enabled, eligibility: 'VERIFIED', blockers: [], checks: READY, verified_at: NOW, delivery }
    : { status: 'ELIGIBILITY_BLOCKED', setup_state: 'NUMBER_ELIGIBILITY_PENDING', can_activate: false, eligibility: 'BLOCKED', blockers: [BLOCK],
        checks: READY.map((c) => (c.key === 'phone_in_waba' ? { ...c, result: 'BLOCKED', reason: 'WRONG_ACCOUNT', detail: BLOCK } : c.key === 'cloud_api_eligibility' ? { ...c, result: 'BLOCKED' } : c)), verified_at: NOW, delivery })
  try {
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')
    // Blocked by a genuine mismatch: Switch on disabled even though the stored state says Connected; the exact reason is shown.
    WA.state = 'CONNECTED'; WA.enabled = false
    await goto('/support/settings?tab=whatsapp')
    await waitFor(`!!document.querySelector('[data-testid=wa-preflight]')`, 'preflight card')
    assert(await evaluate(`document.querySelector('[data-testid=wa-setup]').dataset.status === 'ELIGIBILITY_BLOCKED' && document.querySelector('[data-testid=wa-enable]').disabled
      && document.querySelector('[data-testid=wa-eligibility]').dataset.eligibility === 'BLOCKED'`), 'blocked gate')
    assert(await evaluate(`document.querySelector('[data-testid=wa-state-hint]').innerText.includes('NOT under WABA 1973917729842030')
      && document.querySelector('[data-testid=wa-pf-phone_in_waba]').dataset.result === 'BLOCKED'`), 'exact reason')
    assert(await evaluate(`document.querySelector('[data-testid=wa-pf-reason-phone_in_waba]').innerText.includes('Wrong account')
      && document.querySelector('[data-testid=wa-verified-at]').innerText.includes('latest verification')
      && [...document.querySelectorAll('[data-testid=wa-state-hint] li')].length === 1`), 'reason badge, verification time, one line per blocker')
    await screenshot('290-whatsapp-preflight-blocked')
    // Ready: every mandatory check verified with Meta (no manual ticks) -> Ready to activate -> Switch on -> Active.
    mode = 'ready'
    await goto('/support/settings?tab=whatsapp')
    await waitFor(`document.querySelector('[data-testid=wa-setup]')?.dataset.status === 'READY_TO_ACTIVATE'`, 'ready to activate')
    assert(await evaluate(bodyHasAll('Ready to activate', 'Number eligibility: Verified', 'Verified with Meta', 'Activation preflight', 'not proven yet')), 'ready content')
    assert(await evaluate(`!document.querySelector('[data-testid=wa-enable]').disabled`), 'Switch on enabled')
    await screenshot('291-whatsapp-preflight-ready')
    await click('[data-testid=wa-enable]')
    await waitFor(`document.querySelector('[data-testid=wa-settings-notice]')?.innerText.includes('switched on')`, 'switched on')
    await waitFor(`document.querySelector('[data-testid=wa-setup]')?.dataset.status === 'ACTIVE'`, 'active')
    assert(await evaluate(`document.querySelector('[data-testid=wa-delivery]').innerText.includes('Incoming: not proven yet')`), 'delivery not claimed')
  } finally {
    WA.preflight = null; WA.enabled = false
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
  }
})

await step('Workspace layout: Unified Inbox and Support Automation off the sidebar (routes kept); WhatsApp and Email fit the viewport with no outer scrollbar, only the message / list panels scroll, header and composer stay put, at several window sizes and zoom levels', async () => {
  const PERMS = ['support.view', 'support.manage_tickets', 'support.assign', 'support.reply', 'support.manage_integrations', 'support.view_reports', 'support.manage_settings']
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  const waChannel = SUPPORT_CHANNELS.find((c) => c.channel === 'WHATSAPP')
  const emailChannel = SUPPORT_CHANNELS.find((c) => c.channel === 'EMAIL')
  const before = { wa: waChannel.status, email: emailChannel.status }
  // A long WhatsApp list and conversation; a long email thread with many attachments.
  const waConvs = Array.from({ length: 30 }, (_, i) => supportConv(i === 0 ? 'sc-wa' : `sc-wa-x${i}`, 'WHATSAPP', { subject: null, customer_id: 'scu1', last_message_preview: `Message ${i}` }))
  SUPPORT_INBOX.push(...waConvs)
  WA.extra = Array.from({ length: 60 }, (_, i) => ({ ...WA_THREAD().messages[0], id: `wx${i}`, message_id: `swx${i}`, wa_message_id: `wamid.X${i}`,
    direction: i % 2 ? 'OUTBOUND' : 'INBOUND', status: i % 2 ? 'READ' : 'RECEIVED', body: `Long conversation line ${i}`, author: i % 2 ? 'Smoke Tester' : null }))
  const mailConv = supportConv('sc-mail', 'EMAIL', { subject: 'Cracked basin', customer_id: 'scu1', last_message_preview: 'The basin arrived cracked.' })
  SUPPORT_INBOX.push(mailConv)
  const file = (i) => ({ id: `lx${i}`, file_name: `photo-${i}.jpg`, content_type: 'image/jpeg', size_bytes: 2048, inline: false, storage_path: `${COMPANY_ID}/email/lx/${i}.jpg`, restricted: false })
  const added = Array.from({ length: 12 }, (_, i) => ({ ...GMAIL_THREAD[0], id: `ex${i}`, message_id: `m-ex${i}`, unread: false, gmail_message_id: `ex${i}000000`,
    at: new Date(Date.parse(NOW) - (40 - i) * 3600000).toISOString(), body_text: `Earlier email ${i}.\n${'More text. '.repeat(40)}`, skipped_attachments: [],
    attachments: Array.from({ length: 6 }, (_, k) => file(i * 10 + k)) }))
  GMAIL_THREAD.unshift(...added)
  MAILBOX.extra = Array.from({ length: 40 }, (_, i) => ({ id: `sc-mx${i}`, subject: `Older email ${i}`, snippet: 'Older message.', from_name: 'Meera Shah', from_address: 'meera@shop.example',
    unread_count: 0, has_attachment: false, last_direction: 'INBOUND', last_send_state: null, message_count: 1, to: [], senders: ['Meera Shah'] }))
  WA.web = true; WA.enabled = true; WA.state = 'CONNECTED'; WA.windowOpen = true; WA.prefs = {}; waChannel.status = 'CONNECTED'
  MAILBOX.web = true; MAILBOX.state = {}; GMAIL.connected = true; emailChannel.status = 'CONNECTED'
  // The page itself never scrolls (no outer scrollbar, no horizontal overflow).
  const pageFixed = async (where) => {
    const m = await evaluate(`(() => { const d = document.scrollingElement; return { v: d.scrollHeight - d.clientHeight, h: d.scrollWidth - d.clientWidth, y: scrollY } })()`)
    assert(m.v <= 0 && m.h <= 0 && m.y === 0, `${where}: the page scrolls (${JSON.stringify(m)})`)
  }
  const rect = (sel) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) } })()`)
  const scroller = (sel) => `document.querySelector(${JSON.stringify(sel)}).closest('.overflow-y-auto')`
  // Browser zoom = fewer (125%) or more (80%) CSS pixels in the same window: 1440×900 at 125% is 1152×720, at 80% 1800×1125.
  const SIZES = [[1440, 900, '100%'], [1152, 720, '125% zoom'], [1800, 1125, '80% zoom'], [1280, 720, 'small desktop'], [1024, 768, 'tablet']]
  try {
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')
    await setViewport(1440, 900)

    // Sidebar: the two entries are gone; their pages still open by URL.
    await goto('/support/overview')
    await waitFor(`!!document.querySelector('nav a[href="/support/whatsapp"]')`, 'support section')
    assert(await evaluate(`!document.querySelector('aside[aria-label="Main navigation"] a[href="/support/inbox"]') && !document.querySelector('aside[aria-label="Main navigation"] a[href="/support/automation"]')
      && ['/support/overview', '/support/tickets', '/support/customers', '/support/calls', '/support/whatsapp', '/support/emails', '/support/knowledge-base', '/support/reports', '/support/settings']
        .every((p) => !!document.querySelector('aside[aria-label="Main navigation"] a[href="' + p + '"]'))`), 'support sidebar entries')
    await goto('/support/inbox')
    await waitFor(`!!document.querySelector('[data-testid=inbox-list]')`, 'Unified Inbox still opens')
    await goto('/support/automation')
    await waitFor(`document.querySelector('main h1')?.innerText === 'Support Automation'`, 'Support Automation still opens')
    assert(await evaluate(`!!document.querySelector('footer')`), 'ordinary pages keep the footer')

    for (const [w, h, label] of SIZES) {
      await setViewport(w, h)
      // WhatsApp: list and messages scroll on their own; the header and composer do not move.
      await goto('/support/whatsapp')
      await waitFor(`!!document.querySelector('[data-testid=conversation-sc-wa]')`, `${label}: list`)
      await click('[data-testid=conversation-sc-wa]')
      await waitFor(`!!document.querySelector('[data-testid=wa-messages]') && document.querySelectorAll('[data-testid=wa-messages] > li').length > 50 && !!document.querySelector('[data-testid=wa-composer]')`, `${label}: long chat`)
      await sleep(300)
      await pageFixed(`WhatsApp ${label}`)
      assert(await evaluate(`(() => { const s = ${scroller('[data-testid=wa-messages]')}; return s.scrollHeight > s.clientHeight && s.scrollHeight - s.scrollTop - s.clientHeight < 80 })()`), `${label}: opens at the latest message`)
      const head = await rect('[data-testid=wa-panel] > header')
      const comp = await rect('[data-testid=wa-composer]')
      assert(comp.bottom <= h, `${label}: composer below the window (${comp.bottom} > ${h})`)
      await evaluate(`${scroller('[data-testid=wa-messages]')}.scrollTop = 0`)
      await sleep(150)
      assert(JSON.stringify(await rect('[data-testid=wa-panel] > header')) === JSON.stringify(head) && JSON.stringify(await rect('[data-testid=wa-composer]')) === JSON.stringify(comp), `${label}: header or composer moved`)
      await pageFixed(`WhatsApp ${label} after scrolling messages`)
      const msgTop = await evaluate(`${scroller('[data-testid=wa-messages]')}.scrollTop`)
      await evaluate(`${scroller('[data-testid=wa-web] [data-testid=inbox-list]')}.scrollTop = 400`)
      await sleep(150)
      assert(await evaluate(`${scroller('[data-testid=wa-web] [data-testid=inbox-list]')}.scrollTop`) > 0 && (await evaluate(`${scroller('[data-testid=wa-messages]')}.scrollTop`)) === msgTop, `${label}: list does not scroll on its own`)
      await pageFixed(`WhatsApp ${label} after scrolling the list`)
      if (w === 1440) await screenshot('264-whatsapp-fixed-layout')

      // Email: list scrolls on its own; thread scrolls under a fixed toolbar, also with everything expanded and after a preview.
      await goto('/support/emails?folder=all')
      await waitFor(`document.querySelectorAll('[data-testid=mail-list] > li').length > 40`, `${label}: long mail list`)
      await pageFixed(`Email list ${label}`)
      await evaluate(`${scroller('[data-testid=mail-list]')}.scrollTop = 600`)
      await sleep(100)
      assert(await evaluate(`${scroller('[data-testid=mail-list]')}.scrollTop`) > 0, `${label}: mail list does not scroll`)
      await pageFixed(`Email list ${label} after scrolling`)
      await goto('/support/emails?folder=all&c=sc-mail')
      await waitFor(`!!document.querySelector('[data-testid=mail-expand-all]') && !!document.querySelector('[data-testid=email-em1]')`, `${label}: long thread`)
      await click('[data-testid=mail-expand-all]')
      await waitFor(`document.querySelectorAll('[data-testid=email-thread] article[data-expanded=true]').length === 13`, `${label}: all expanded`)
      await sleep(200)
      await pageFixed(`Email thread ${label} expanded`)
      const bar = await rect('[role=toolbar][aria-label="Thread actions"]')
      const side = await rect('[data-testid=mail-workspace] [data-testid=mail-rail]')
      await evaluate(`${scroller('[data-testid=email-thread]')}.scrollTop = 99999`)
      await sleep(150)
      assert(await evaluate(`${scroller('[data-testid=email-thread]')}.scrollTop`) > 0, `${label}: thread does not scroll`)
      assert(JSON.stringify(await rect('[role=toolbar][aria-label="Thread actions"]')) === JSON.stringify(bar) && JSON.stringify(await rect('[data-testid=mail-workspace] [data-testid=mail-rail]')) === JSON.stringify(side), `${label}: toolbar or rail moved`)
      assert((await rect('[data-testid=mail-reply-bar]')).bottom <= h, `${label}: reply buttons cut off at the end of the thread`)
      await pageFixed(`Email thread ${label} scrolled`)
      await evaluate(`document.querySelector('[data-testid=email-ex0] [data-testid=email-attachment] > button').click()`)
      await waitFor(`!!document.querySelector('[data-testid=attachment-preview]')`, `${label}: preview`)
      await pageFixed(`Email ${label} with a preview open`)
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await waitFor(`!document.querySelector('[data-testid=attachment-preview]')`, `${label}: preview closed`)
      await pageFixed(`Email ${label} after the preview`)
      if (w === 1440) await screenshot('265-email-fixed-layout')
    }

    // Phone: the open chat / thread fills the screen; composer and last message visible; nothing scrolls sideways.
    await setViewport(390, 844)
    await goto('/support/whatsapp')
    await waitFor(`!!document.querySelector('[data-testid=conversation-sc-wa]')`, 'phone list')
    await pageFixed('WhatsApp phone list')
    await click('[data-testid=conversation-sc-wa]')
    await waitFor(`!!document.querySelector('[data-testid=wa-composer]') && document.querySelectorAll('[data-testid=wa-messages] > li').length > 50`, 'phone chat')
    await sleep(300)
    assert((await rect('[data-testid=wa-composer]')).bottom <= 844, 'phone composer visible')
    assert(await evaluate(`(() => { const s = ${scroller('[data-testid=wa-messages]')}; const last = [...document.querySelectorAll('[data-testid=wa-messages] > li')].at(-1).getBoundingClientRect(); return last.bottom <= s.getBoundingClientRect().bottom + 1 })()`), 'phone: last message visible')
    await pageFixed('WhatsApp phone chat')
    await screenshot('266-whatsapp-phone-layout')
    await goto('/support/emails?folder=all&c=sc-mail')
    await waitFor(`!!document.querySelector('[data-testid=email-em1]')`, 'phone thread')
    await pageFixed('Email phone thread')
    await cdp('Emulation.clearDeviceMetricsOverride')
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
    for (const c of [...waConvs, mailConv]) SUPPORT_INBOX.splice(SUPPORT_INBOX.indexOf(c), 1)
    GMAIL_THREAD.splice(0, added.length)
    WA.extra = []; MAILBOX.extra = []
    waChannel.status = before.wa; emailChannel.status = before.email
    WA.web = false; WA.enabled = false; WA.state = 'MIGRATION_REQUIRED'; WA.prefs = {}
    MAILBOX.web = false; MAILBOX.state = {}; GMAIL.connected = false
  }
})

await step('Accounts: every page renders from the accounting RPCs (dashboard, chart, ledgers, register, voucher, trial balance, general ledger, day book, opening balances, posting monitor, settings); posting needs a confirmation; a user without accounting permissions sees no Accounts section', async () => {
  const PERMS = ['accounts.read', 'accounts.manage', 'vouchers.read', 'vouchers.create', 'vouchers.post', 'vouchers.reverse', 'accounting_opening.import', 'accounting_opening.approve',
    'accounting_period.close', 'accounting_reports.read', 'accounting_settings.manage', 'accounting_posting.manage']
  // Without accounting permissions the section is hidden and the page is refused before any accounting RPC is called.
  const before = requests.filter((r) => r.path.startsWith('/rest/v1/rpc/accounting_')).length
  await goto('/accounts')
  await waitFor(bodyHas('Access denied'), 'access denied without permission')
  assert(!(await evaluate(`[...document.querySelectorAll('nav a')].some((a) => a.getAttribute('href') === '/accounts')`)), 'Accounts shown without permission')
  assert(requests.filter((r) => r.path.startsWith('/rest/v1/rpc/accounting_')).length === before, 'accounting data requested without permission')
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  try {
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')
    await goto('/accounts')
    await waitFor(bodyHasAll('Accounting Dashboard', 'Books balance', 'Balanced', 'Postings needing attention'), 'dashboard')
    assert(await evaluate(`!!document.querySelector('[data-testid=accounting-notice]')`), 'accounting notice missing')
    assert(await evaluate(bodyHas('Customer receipts by UPI have no cash / bank')), 'unmapped payment method warning')
    assert(await evaluate(`[...document.querySelectorAll('nav a')].some((a) => a.getAttribute('href') === '/accounts/trial-balance')`), 'Accounts section missing in the sidebar')
    await screenshot('accounts-01-dashboard')

    await goto('/accounts/chart')
    await waitFor(bodyHasAll('Chart of Accounts', 'Bank Accounts', 'HDFC Current A/c', '11,800.00 Dr'), 'chart tree')
    await goto('/accounts/ledgers')
    await waitFor(bodyHasAll('Ledger Accounts', 'Sundry Debtors (Control)', 'Automatic only', '10,000.00 Cr'), 'ledger accounts')

    await goto('/accounts/vouchers')
    await waitFor(bodyHasAll('Voucher Register', 'Sales invoice INV/1', 'Draft'), 'register')
    assert(rpcCalls('accounting_voucher_list').length > 0, 'register not read from accounting_voucher_list')
    await goto('/accounts/vouchers/av1')
    await waitFor(bodyHasAll('Sundry Debtors (Control)', 'Output CGST', 'Mock Customer', 'Balanced', 'Audit history'), 'posted voucher')
    assert(!(await evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Reverse')`)), 'automatic voucher offered a manual reversal')

    // A manual draft: Post asks for confirmation; nothing is posted until confirmed.
    await goto('/accounts/vouchers/av2')
    await waitFor(bodyHasAll('Bank charges', 'Draft'), 'draft voucher')
    const posts = rpcCalls('accounting_voucher_post').length
    await click('button', 'Post')
    await waitFor(bodyHas('Posting assigns the voucher number'), 'post confirmation')
    assert(rpcCalls('accounting_voucher_post').length === posts, 'posted without confirmation')
    await click('[role=dialog] button', 'Post voucher')
    await waitFor(bodyHas('posted.'), 'posted message')
    assert(rpcCalls('accounting_voucher_post').length === posts + 1, 'post RPC not called once')

    await goto('/accounts/trial-balance')
    await waitFor(bodyHasAll('Trial Balance', 'Debit = credit', 'HDFC Current A/c', 'Total'), 'trial balance')
    await goto('/accounts/general-ledger?account=acc-bank')
    await waitFor(bodyHasAll('1210 HDFC Current A/c', 'Opening balance', 'Closing balance', '11,800.00 Dr'), 'general ledger')
    await goto('/accounts/day-book')
    await waitFor(bodyHasAll('Day Book', 'Sundry Debtors (Control)', '1 voucher(s)'), 'day book')

    await goto('/accounts/opening-balances')
    await waitFor(bodyHasAll('OB-0001', 'Reconciliation', 'Debtors equal the ERP customer opening balances', 'Mock Customer', 'Add ERP party balances'), 'opening balances')
    assert(await evaluate(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Approve')?.disabled === true`), 'approve enabled without an acknowledgement')

    await goto('/accounts/posting-monitor')
    await waitFor(bodyHasAll('Posting Monitor', 'RCPT/1', 'Needs account mapping'), 'posting monitor')
    await click('button', 'Run posting now')
    await waitFor(bodyHas('2 new document event(s) found; 2 processed'), 'posting run result')

    await goto('/accounts/settings')
    await waitFor(bodyHasAll('Accounting Settings', 'Books start date', 'Segregation of duties'), 'settings: books')
    await goto('/accounts/settings?tab=periods')
    await waitFor(bodyHasAll('Accounting periods', 'Close'), 'settings: periods')
    await goto('/accounts/settings?tab=rules')
    await waitFor(bodyHasAll('Automatic posting accounts', 'Cash and bank accounts by payment method', 'Not mapped — never guessed'), 'settings: rules')
    await goto('/accounts/settings?tab=cost-centres')
    await waitFor(bodyHasAll('Cost centres', 'Production'), 'settings: cost centres')
    await screenshot('accounts-02-settings')
    assert(!requests.some((r) => /^\/rest\/v1\/(accounting_|accounts|account_groups)/.test(r.path)), 'an accounting table was queried directly')
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
    await signOut().catch(() => {})
    await login('manager@test.invalid').catch(() => {})
  }
})

await step('Journal Entry and Register: searchable accounts (no control accounts), live totals and Balanced / Unbalanced, Save draft, Validate, Post only after confirmation; register filters, view, edit draft and reversal with a reason', async () => {
  const PERMS = ['accounts.read', 'vouchers.read', 'vouchers.create', 'vouchers.post', 'vouchers.reverse', 'accounting_reports.read']
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  try {
    await goto('/')
    await waitFor(bodyHas('Smoke Tester'), 'signed-in layout')
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')
    await goto('/accounts/journals/new')
    await waitFor(bodyHasAll('New journal voucher', 'Voucher number', 'Save draft', 'Validate', 'Unbalanced'), 'journal entry form')
    assert(await evaluate(`document.querySelector('#jv-number')?.value === 'Assigned automatically on posting'`), 'voucher number is not automatic')
    // Line 1: searchable account picker; the Debtors control account is not offered.
    await click('#jv-acc-0')
    await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('HDFC Current A/c'))`, 'account options')
    assert(!(await evaluate(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('Sundry Debtors'))`)), 'control account offered for a manual journal')
    await click('[role=option]', 'HDFC Current A/c')
    await fill('input[aria-label="Line 1 debit"]', '250')
    await click('#jv-acc-1')
    await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('4100'))`, 'account options 2')
    await click('[role=option]', '4100')
    await fill('input[aria-label="Line 2 credit"]', '200')
    await waitFor(`document.querySelector('[data-testid=journal-totals]')?.innerText.includes('Unbalanced')`, 'unbalanced shown')
    assert(await evaluate(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Post')?.disabled === true`), 'Post enabled while unbalanced')
    await fill('input[aria-label="Line 2 credit"]', '250')
    await waitFor(`document.querySelector('[data-testid=journal-totals]')?.innerText.includes('Balanced') && !document.querySelector('[data-testid=journal-totals]').innerText.includes('Unbalanced')`, 'balanced shown')
    await fill('#jv-narr', 'Bank charges for the month')
    const creates = rpcCalls('accounting_voucher_create').length
    await click('button', 'Save draft')
    await waitFor(bodyHas('Draft saved.'), 'draft saved')
    const sent = rpcCalls('accounting_voucher_create').at(-1)?.body?.p_voucher
    assert(rpcCalls('accounting_voucher_create').length === creates + 1 && sent?.voucher_type === 'JV' && sent.lines.length === 2 && sent.lines[0].debit === '250'
      && sent.lines[0].credit === null && sent.lines[1].credit === '250' && sent.narration === 'Bank charges for the month', JSON.stringify(sent))
    await click('button', 'Validate')
    await waitFor(bodyHas('The journal is valid and can be posted.'), 'validated')
    const posts = rpcCalls('accounting_voucher_post').length
    await click('button', 'Post')
    await waitFor(bodyHas('A posted journal can never'), 'post confirmation')
    assert(rpcCalls('accounting_voucher_post').length === posts, 'posted before confirmation')
    await click('[role=dialog] button', 'Post journal')
    await waitFor(`location.pathname === '/accounts/vouchers/av2'`, 'opened the posted journal')
    assert(rpcCalls('accounting_voucher_post').length === posts + 1, 'post not called once')
    await screenshot('accounts-03-journal-posted')

    await goto('/accounts/journals')
    await waitFor(bodyHasAll('Journal Register', 'JV/00/000007', 'Office rent accrual', 'Created by', 'Voucher number'), 'journal register')
    assert(rpcCalls('accounting_voucher_list').at(-1)?.body?.p_filters?.voucher_type === 'JV', 'register did not ask for journal vouchers')
    assert(await evaluate(`[...document.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/accounts/journals/av2/edit')`), 'no edit link for the draft')
    await click('button', 'Reverse')
    await waitFor(bodyHas('A linked reversal voucher'), 'reverse dialog')
    const reversals = rpcCalls('accounting_voucher_reverse').length
    await click('[role=dialog] button', 'Reverse journal')
    await waitFor(bodyHas('Enter at least 5 characters.'), 'reason required')
    assert(rpcCalls('accounting_voucher_reverse').length === reversals, 'reversal sent without a reason')
    await fill('[role=dialog] textarea', 'Rent booked to the wrong month')
    await click('[role=dialog] button', 'Reverse journal')
    await waitFor(bodyHas('reversed by REV/00/000001'), 'reversed')
    assert(rpcCalls('accounting_voucher_reverse').at(-1)?.body?.p_reason === 'Rent booked to the wrong month', 'reason not sent')
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
    await signOut().catch(() => {})
    await login('manager@test.invalid').catch(() => {})
  }
})

await step('Cost centres (Phase 2): master with hierarchy and types; a journal line split over cost centres; budgets with approval; summary, ledger, profitability and budget vs actual with unallocated shown apart; cost-centre filter on the general ledger', async () => {
  const PERMS = ['accounts.read', 'accounts.manage', 'vouchers.read', 'vouchers.create', 'vouchers.post', 'accounting_reports.read', 'accounting_budgets.read', 'accounting_budgets.manage',
    'accounting_budgets.approve']
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  try {
    await goto('/')
    await waitFor(bodyHas('Smoke Tester'), 'signed-in layout')
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')
    await goto('/accounts/cost-centres')
    await waitFor(bodyHasAllCI('Cost Centres', 'Production', 'Administration', 'Warehouse', '3 posted'), 'cost centre master')
    assert(!(await evaluate(`[...document.querySelectorAll('tr')].find((r) => r.innerText.includes('Production'))?.innerText.includes('Delete')`)), 'a used cost centre offered for deletion')
    await click('button', 'New cost centre')
    await waitFor(bodyHas('The code is fixed once created'), 'new cost centre dialog')
    await fill('#ccd-code', 'RD')
    await fill('#ccd-name', 'Research')
    await fill('#ccd-from', '2026-04-01')
    await click('[role=dialog] button', 'Save')
    await waitFor(bodyHas('RD created.'), 'cost centre saved')
    const saved = rpcCalls('accounting_cost_centre_save').at(-1)?.body?.p_cost_centre
    assert(saved?.cost_centre_code === 'RD' && saved.cost_centre_type === 'DEPARTMENT' && saved.effective_from === '2026-04-01', JSON.stringify(saved))

    // Journal line split over two cost centres.
    await goto('/accounts/journals/new')
    await waitFor(bodyHasAllCI('New journal voucher', 'Cost centres'), 'journal form')
    await click('#jv-acc-0')
    await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('4100'))`, 'options')
    await click('[role=option]', '4100')
    await fill('input[aria-label="Line 1 debit"]', '1000')
    await click('[data-testid=jv-split-0]')
    await waitFor(bodyHas('Split the debit of 1,000.00'), 'split dialog')
    await click('#alloc-cc-0')
    await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('PROD'))`, 'cc options')
    await click('[role=option]', 'PROD')
    await fill('input[aria-label="Allocation 1 amount"]', '600')
    await click('[role=dialog] button', 'Add cost centre')
    await click('#alloc-cc-1')
    await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('ADMIN'))`, 'cc options 2')
    await click('[role=option]', 'ADMIN')
    await fill('input[aria-label="Allocation 2 amount"]', '300')
    await waitFor(`document.querySelector('[data-testid=allocation-remaining]')?.innerText.includes('remaining 100.00')`, 'remaining shown')
    await click('[role=dialog] button', 'Put the remaining')
    await waitFor(`document.querySelector('[data-testid=allocation-remaining]')?.innerText.includes('remaining 0.00')`, 'fully allocated')
    await click('[role=dialog] button', 'Apply split')
    await waitFor(`document.querySelector('[data-testid=jv-split-0]')?.innerText.includes('2 cost centres')`, 'split applied')
    await click('#jv-acc-1')
    await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('2210'))`, 'options 2')
    await click('[role=option]', '2210')
    await fill('input[aria-label="Line 2 credit"]', '1000')
    await click('button', 'Save draft')
    await waitFor(bodyHas('Draft saved.'), 'draft saved')
    const sent = rpcCalls('accounting_voucher_create').at(-1)?.body?.p_voucher
    assert(JSON.stringify(sent?.lines[0].allocations) === JSON.stringify([{ cost_centre_id: 'cc1', amount: '600' }, { cost_centre_id: 'cc2', amount: '400.00' }]), JSON.stringify(sent?.lines))

    // Budgets: draft with lines and history; approval needs a confirmation.
    await goto('/accounts/cost-centres/budgets')
    await waitFor(bodyHasAllCI('Operating budget', 'version 1', 'budget.xlsx', 'Approval history', 'imported'), 'budget page')
    const approvals = rpcCalls('accounting_budget_approve').length
    await click('button', 'Approve')
    await waitFor(bodyHas('The approved budget is used by the budget versus actual reports'), 'approve dialog')
    assert(rpcCalls('accounting_budget_approve').length === approvals, 'approved without confirmation')
    await click('[role=dialog] button', 'Approve budget')
    await waitFor(bodyHas('Version 1 approved.'), 'approved')

    // Reports.
    await goto('/accounts/cost-centres/reports')
    await waitFor(bodyHasAllCI('Cost centre summary', 'Production', 'Unallocated (no cost centre)', 'Company total', 'Allocated + unallocated = company totals'), 'summary report')
    assert(await evaluate(`document.querySelectorAll('[data-testid=cc-summary-row]').length === 3`), 'summary rows')
    await goto('/accounts/cost-centres/reports?tab=ledger&cc=cc1')
    await waitFor(bodyHasAllCI('PROD Production', 'Electricity bill', 'Closing balance', '58,000.00 Dr'), 'cost centre ledger')
    await goto('/accounts/cost-centres/reports?tab=profitability')
    await waitFor(bodyHasAllCI('Direct expenses', 'Indirect expenses', 'Net contribution', '-58,000.00'), 'profitability')
    await goto('/accounts/cost-centres/reports?tab=budget')
    await waitFor(bodyHasAllCI('Budget vs actual', 'Approved budget version 1', '6,00,000.00', '-5.00%'), 'budget vs actual')
    await goto('/accounts/general-ledger?account=acc-gst&cc=cc1')
    await waitFor(bodyHas('allocated share of one cost centre'), 'general ledger cost-centre filter')
    assert(rpcCalls('accounting_general_ledger').at(-1)?.body?.p_cost_centre_id === 'cc1', 'cost centre not sent to the general ledger')
    await screenshot('accounts-04-cost-centres')
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
    ACC.budgetStatus = 'DRAFT'
    await signOut().catch(() => {})
    await login('manager@test.invalid').catch(() => {})
  }
})

await step('Supplier invoices (Phase 3): register; GRN matching starts an invoice with receipt lines plus a direct line split over cost centres; a price variance approved with a reason; posting; GST verified with the checks; a payment allocated; GRN reconciliation and ageing reports', async () => {
  const PERMS = ['purchase_invoices.read', 'purchase_invoices.create', 'purchase_invoices.approve', 'purchase_invoices.post', 'purchase_invoices.verify_gst',
    'purchase_invoices.reverse', 'supplier_payment.manage']
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  try {
    await goto('/')
    await waitFor(bodyHas('Smoke Tester'), 'signed-in layout')
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')
    await goto('/purchases/invoices')
    await waitFor(bodyHasAllCI('Supplier Invoices', 'PINV-000001', 'S1/M-002', 'Variance — needs approval', '495.60'), 'invoice register')

    // GRN matching → new invoice with the receipt line; add a direct line split over cost centres; save the draft.
    await goto('/purchases/invoices/matching?supplier=sup1')
    await waitFor(bodyHasAllCI('GRN Matching', 'GRN-0002', 'Partly invoiced', '1,180.00'), 'matching candidates')
    await click('button[role=checkbox][aria-label^="Select GRN-0002"]')
    await click('button', 'Invoice 1 selected')
    await waitFor(bodyHasAllCI('New supplier invoice', 'GRN-0002', 'Uninvoiced 4'), 'invoice form with the receipt line')
    await waitFor(`document.querySelector('[data-testid=pi-grand-total]')?.innerText === '472.00'`, 'receipt line preview 400 + 72')
    await fill('#pi-number', 'S1/NEW-9')
    await click('button', 'Add direct line')
    await click('#pi-acc-1')
    await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('6500'))`, 'account options')
    await click('[role=option]', '6500')
    await fill('input[aria-label="Line 2 unit price"]', '10000')
    await waitFor(`document.querySelector('[data-testid=pi-grand-total]')?.innerText === '12,272.00'`, 'total with the direct line')
    await fill('#pi-stated', '12272.00')
    await click('button', 'Save and submit')
    await waitFor(bodyHas('this account needs a cost-centre split'), 'cost-centre split required before submitting')
    assert(rpcCalls('purchase_invoice_save').length === 0, 'saved without the required split')
    await click('button[aria-label="Line 2 cost centres"]')
    await waitFor(bodyHas('Split the debit of 10,000.00'), 'split dialog')
    await click('#alloc-cc-0')
    await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('PROD'))`, 'cc options')
    await click('[role=option]', 'PROD')
    await fill('input[aria-label="Allocation 1 amount"]', '10000')
    await click('[role=dialog] button', 'Apply split')
    await waitFor(`document.querySelector('[data-testid=pi-line-split]')?.innerText.includes('PROD')`, 'split applied')
    await click('button', 'Save draft')
    await waitFor(`location.pathname === '/purchases/invoices/pi-new/edit'`, 'draft saved and reopened for editing')
    const sent = rpcCalls('purchase_invoice_save').at(-1)?.body
    assert(sent?.p_invoice_id === null && sent.p_invoice.supplier_id === 'sup1' && sent.p_invoice.supplier_stated_total === '12272.00'
      && JSON.stringify(sent.p_invoice.lines[0]) === JSON.stringify({ kind: 'GRN', goods_receipt_line_id: 'grl2', description: 'Wash basin', quantity: '4', unit_price: '100', discount: '0', gst_rate: '18', cess: '0' })
      && sent.p_invoice.lines[1].account_id === 'acc-6500' && JSON.stringify(sent.p_invoice.lines[1].allocations) === JSON.stringify([{ cost_centre_id: 'cc1', amount: '10000' }]), JSON.stringify(sent))

    // Approval of a price variance needs the explicit acceptance and a reason; then post.
    await goto('/purchases/invoices/pi1')
    await waitFor(bodyHasAllCI('PINV-000001', 'Variances against the goods receipts', 'outside the tolerance', 'Attachments'), 'submitted invoice with a variance')
    await click('button', 'Approve')
    await waitFor(bodyHas('I accept these variances'), 'approve dialog')
    assert(await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.trim() === 'Approve')?.disabled === true`), 'approve enabled without acceptance')
    await click('[role=dialog] button[role=checkbox]')
    await fill('#pi-approve-note', 'Supplier price revision agreed by purchase')
    await click('[role=dialog] button', 'Approve')
    await waitFor(bodyHas('Invoice approved.'), 'approved')
    assert(rpcCalls('purchase_invoice_approve').at(-1)?.body?.p_accept_variances === true, 'variances not accepted explicitly')
    await click('button', 'Post')
    await waitFor(bodyHas('Matched receipt lines post only their differences'), 'post confirmation')
    await click('[role=dialog] button', 'Post to the accounts')
    await waitFor(bodyHasAllCI('Posted as voucher PIN/26-27/000001', 'Reconciliation with the goods receipts', 'No duplicate payable', '23.60'), 'posted and reconciled')

    // GST decision (Gate C maker-checker): the three checks and a reason are required for eligible credit; the proposal is approved by another user.
    await click('button', 'Propose GST decision')
    await waitFor(bodyHas('only after another user approves this proposal (maker-checker)'), 'GST dialog')
    assert(await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.includes('Propose decision'))?.disabled === true`), 'GST proposable without checks')
    await evaluate(`document.querySelectorAll('[role=dialog] button[role=checkbox]').forEach((b) => b.click())`)
    await fill('#pi-gst-reason', 'Invoice and GSTIN checked against the supplier copy')
    await click('[role=dialog] button', 'Propose decision')
    await waitFor(bodyHasAllCI('ITC decision proposed (eligible)', 'ITC proposal (awaiting approval)', 'Matched: S1/M-002 (2026-10)'), 'GST proposed with the GSTR-2B evidence')
    assert(!(await evaluate(`document.body.innerText.includes('PIN/26-27/000002')`)), 'no GST voucher before approval')
    await click('button', 'Approve GST decision')
    await waitFor(bodyHas('the person who proposed it cannot approve it'), 'approve dialog')
    await click('[role=dialog] button', 'Approve and post')
    await waitFor(bodyHasAllCI('ITC decision approved — GST eligible.', 'PIN/26-27/000002'), 'GST approved and posted')
    assert(rpcCalls('gst_itc_action').at(-1)?.body?.p_action === 'APPROVE', 'approval through gst_itc_action')
    const gst = rpcCalls('purchase_invoice_verify_gst').at(-1)?.body
    assert(gst?.p_status === 'ELIGIBLE' && gst.p_checks.invoice_verified && gst.p_checks.goods_services_received && gst.p_checks.gstin_valid, JSON.stringify(gst))

    // Allocate a payment.
    await click('button', 'Allocate payment')
    await waitFor(bodyHas('Payments are recorded in the Ledger'), 'payment dialog')
    await click('#pi-pay')
    await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('SPAY-0001'))`, 'payment options')
    await click('[role=option]', 'SPAY-0001')
    await waitFor(`document.querySelector('#pi-pay-amount')?.value === '495.60'`, 'amount defaults to the outstanding')
    await click('[role=dialog] button', 'Allocate')
    await waitFor(bodyHasAllCI('Payment allocated.', 'SPAY-0001'), 'payment allocated')
    assert(rpcCalls('purchase_invoice_allocate_payment').at(-1)?.body?.p_amount === '495.60', 'allocation amount')

    // Reports.
    await goto('/purchases/invoices/reconciliation')
    await waitFor(bodyHasAllCI('Supplier Invoice Reports', 'GRN-0001', 'Difference posted', '23.60', 'FULLY INVOICED'), 'GRN vs invoice report')
    await goto('/purchases/invoices/reconciliation?report=AGEING')
    await waitFor(bodyHasAllCI('Creditors ledger balance', '2,913.60', 'Not due'), 'AP ageing')
    await screenshot('accounts-05-supplier-invoices')
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
    Object.assign(PI, { status: 'SUBMITTED', gst: 'PENDING_VERIFICATION', paid: 0, proposed: null })
    await signOut().catch(() => {})
    await login('manager@test.invalid').catch(() => {})
  }
})

await step('GSTR-2B (Phase 5, Gate C): import preview with the server checksum and row errors; import only valid rows; matching with a partial outcome approved with a note; exception reports', async () => {
  const PERMS = ['gst_reconciliation.read', 'gst_reconciliation.manage', 'gst_reconciliation.approve']
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  try {
    await goto('/')
    await waitFor(bodyHas('Smoke Tester'), 'signed-in layout')
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')
    await goto('/accounts/gst/gstr-2b')
    await waitFor(bodyHasAllCI('GSTR-2B Matching', 'there is no direct portal connection', 'never post vouchers and never approve ITC', 'GSTR2B_102026.xlsx', 'Upload and verify'), 'imports')
    await click('td', 'GSTR2B_102026.xlsx')
    await waitFor(bodyHasAllCI('Server SHA-256', 'Import would add', '2 new', 'Skipped sheets', 'ISD', 'is not a valid GSTIN'), 'preview')
    assert(await evaluate(`document.querySelector('[data-testid=g2b-commit]')?.disabled === true`), 'import with errors needs the acknowledgement')
    await click('label', 'Import only the valid rows')
    await waitFor(`document.querySelector('[data-testid=g2b-commit]')?.disabled === false`, 'import enabled after the acknowledgement')
    await click('[data-testid=g2b-commit]')
    await waitFor(bodyHas('No voucher is posted and no ITC is decided.'), 'import confirmation')
    await click('[role=dialog] button', 'Import valid rows')
    await waitFor(bodyHas('Imported: 2 new, 0 amendments, 0 changed.'), 'imported')
    assert(rpcCalls('gst_2b_import_commit').at(-1)?.body?.p_accept_errors === true, 'commit accepted errors explicitly')

    await click('[role=tab]', 'Matching')
    await waitFor(bodyHasAllCI('S1/M-002', 'Awaiting approval', 'Partial (within tolerance)'), 'documents')
    await click('button', 'Propose matches')
    await waitFor(bodyHas('Each proposal needs approval by another user.'), 'auto-match proposes only')
    await click('td', 'S1/M-002')
    await waitFor(bodyHasAllCI('Versions', 'sgst GSTR-2B 38.3 / books 37.8', 'Other Accountant', 'Tolerance applied', '(configuration v1)', 'not exact: approval needs a note'), 'document panel')
    await click('button', 'Approve')
    await waitFor(bodyHasAllCI('you cannot approve a match you proposed', 'Why the differences are acceptable'), 'approve dialog')
    await fill('#action-note', 'Supplier rounding of 50 paise on SGST')
    await click('[role=dialog] button', 'Approve match')
    await waitFor(bodyHas('Match approved.'), 'match approved')
    assert(rpcCalls('gst_2b_match_decide').at(-1)?.body?.p_note === 'Supplier rounding of 50 paise on SGST', 'approval note')

    await click('[role=tab]', 'Exceptions & reports')
    await waitFor(bodyHasAllCI('never posts vouchers and never approves ITC', 'missing in books'), 'summary')
    await goto('/accounts/gst/gstr-2b?tab=reports&report=MISSING_IN_BOOKS')
    await waitFor(bodyHasAllCI('S1/M-003', '1 row(s)'), 'missing in books')
    await screenshot('accounts-07-gstr2b')
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
    Object.assign(G2B, { committed: false, approved: false })
    await signOut().catch(() => {})
    await login('manager@test.invalid').catch(() => {})
  }
})

await step('GST returns (Phase 5, Gate D): dashboard; GSTR-1 live with a manual adjustment shown apart; GSTR-3B from the approved snapshot with historical / current credit; registers with signed credit notes; reconciliation; exceptions; working-file export; filing recorded manually', async () => {
  const PERMS = ['gst.read', 'gst_returns.prepare', 'gst_returns.approve', 'gst_periods.close']
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  try {
    await goto('/')
    await waitFor(bodyHas('Smoke Tester'), 'signed-in layout')
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')
    await goto('/accounts/gst/returns')
    await waitFor(bodyHasAllCI('GST Returns', 'This system does not file returns and has no GSTN or portal connection', 'Return periods', '2026-10', 'snapshot v1', 'GSTR-2B missing in books'), 'dashboard')
    await goto('/accounts/gst/returns?tab=gstr1&period=gp-nov')
    await waitFor(bodyHasAllCI('Manually adjusted', 'Live from documents', 'INV-0001', 'HSN summary', 'Excluded from the return: 2 draft / pending, 1 cancelled', 'missing hsn 1'), 'GSTR-1 live')
    await goto('/accounts/gst/returns?tab=gstr3b&period=gp-nov')
    await waitFor(`!!document.querySelector('[data-section="3.1(a)"][data-kind="adjusted"]') && ${bodyHasAllCI('Advance received, tax paid', '2,02,000.00', '2,01,500.00')}`, 'calculated and adjusted rows kept apart')
    await goto('/accounts/gst/returns?tab=gstr3b&period=gp-oct')
    await waitFor(bodyHasAllCI('Approved (snapshot)', 'Approved snapshot v1', 'Credit position', 'Available at period end', '350.00', '440.00', '6.1 Payment of tax', 'evidence only'), 'GSTR-3B from the snapshot')
    assert(!(await evaluate(`!!document.querySelector('[data-section="3.1(a)"][data-kind="adjusted"]')`)), 'no adjusted row without an approved adjustment')
    await click('button', 'Working file')
    await click('[role=menuitem]', 'Excel')
    await waitFor(`true`, 'export started')
    // Filing: recorded by the user after filing on the portal.
    await fill('#arn-GSTR3B', 'aa2710261234567')
    await fill('#filed-GSTR3B', TODAY)
    await click('button', 'Record filing')
    await waitFor(bodyHasAllCI('GSTR3B filing recorded (ARN AA2710261234567).', 'Filed (recorded)', 'ARN AA2710261234567'), 'filing recorded')
    assert(rpcCalls('gst_return_filing').at(-1)?.body?.p?.arn === 'AA2710261234567', 'ARN normalised')
    await goto('/accounts/gst/returns?tab=registers&period=gp-nov')
    await waitFor(bodyHasAllCI('Sales register', 'INV-0001', 'CN-0001', '-100.00'), 'register with a signed credit note')
    await goto('/accounts/gst/returns?tab=reconciliation&period=gp-nov')
    await waitFor(bodyHasAllCI('Tax-head summary and ledger reconciliation', '-35,980.00', 'JV/26-27/000012'), 'reconciliation')
    await goto('/accounts/gst/returns?tab=exceptions&period=gp-nov')
    await waitFor(bodyHasAllCI('1 exception(s)', 'missing hsn', 'INV-0009'), 'exceptions')
    await goto('/accounts/gst/returns?tab=payments&period=gp-oct')
    await waitFor(bodyHasAllCI('26112700000001', 'CIN 26112700000001HDFC', 'credit IGST'), 'payments and set-offs')
    await screenshot('accounts-08-gst-returns')
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
    GR.filed = null
    await signOut().catch(() => {})
    await login('manager@test.invalid').catch(() => {})
  }
})

await step('GST period close (Phase 5, Gate E): lifecycle with filed status; blockers and warnings apart (an open warning is never passed); close needs an acknowledgement; control reports with tolerance, Excel / CSV export and a print layout with header and page numbers', async () => {
  const PERMS = ['gst.read', 'gst_returns.prepare', 'gst_returns.approve', 'gst_periods.close']
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  try {
    await goto('/')
    await waitFor(bodyHas('Smoke Tester'), 'signed-in layout')
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')
    GR.filed = 'AA2710261234567'
    await goto('/accounts/gst/returns?tab=close&period=gp-oct')
    await waitFor(`document.querySelector('[data-step="FILED"]')?.dataset.state === 'current' && ${bodyHasAllCI('Mandatory close controls (blockers)', 'Warnings (never treated as passed)', 'Reopened 1×', 'filed (recorded): GSTR3B ARN AA2710261234567')}`, 'lifecycle and controls')
    assert(await evaluate(`document.querySelector('[data-control="SOURCE_ERRORS"]').dataset.state === 'Open warning' && document.querySelector('[data-control="SET_OFF_DRAFT"]').dataset.state === 'Passed'
      && document.querySelector('[data-control="LEDGER_UNRECONCILED"]').dataset.state === 'Clear'`), 'warning shown as open, blocker as passed')
    assert(!(await evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.includes('Reopen period'))`)), 'no reopen for a filed period / without the Super Admin permission')
    await click('button', 'Close period')
    await waitFor(bodyHas('Acknowledge the open warnings'), 'close dialog requires an acknowledgement')
    const closeCalls = rpcCalls('gst_period_transition').length
    await click('[role=dialog] button', 'Close period')
    await waitFor(bodyHas('Enter at least 10 characters.'), 'acknowledgement required')
    assert(rpcCalls('gst_period_transition').length === closeCalls, 'close sent without acknowledgement')
    await fill('#action-note', 'Two source errors reviewed; corrected in the next return')
    await click('[role=dialog] button', 'Close period')
    await waitFor(bodyHas('2026-10 closed.'), 'closed')
    assert(rpcCalls('gst_period_transition').at(-1)?.body?.p_reason === 'Two source errors reviewed; corrected in the next return', 'acknowledgement sent')

    await goto('/accounts/gst/returns?tab=reports&period=gp-oct')
    await waitFor(bodyHasAllCI('1. GST tax liability reconciliation', 'Sources:', 'Alton Hi-Tech Sanitary Ware', 'GSTIN 27AABCA1234A1Z5', 'FY 2026-27', 'snapshot v1',
      'This document is not proof of filing with the GST Portal', '-36,520.00'), 'report 1 with header and negative difference')
    assert(await evaluate(`[...document.querySelectorAll('[data-testid=gst-control-report] td span')].some((x) => x.innerText.includes('-36,520.00') && x.className.includes('text-red-700'))`), 'negative in red')
    await click('#gstc-report')
    await click('[role=option]', '3. GSTR-2B reconciliation')
    await waitFor(bodyHasAllCI('Tolerance applied', 'Config version', 'S1/M-002', 'partial'), 'report 3 with tolerance')
    await click('button', 'Export')
    await waitFor(`[...document.querySelectorAll('[role=menuitem]')].some((m) => m.innerText.includes('CSV — Documents'))`, 'export menu: Excel and one CSV per table')
    await click('[role=menuitem]', 'Excel')
    // Print layout: the header (company, GSTIN, period, status, disclaimer) is shown and the controls are hidden.
    await cdp('Emulation.setEmulatedMedia', { media: 'print' })
    await waitFor(`matchMedia('print').matches`, 'print media emulated')
    await waitFor(`getComputedStyle(document.querySelector('[data-testid=gst-print-header]')).display !== 'none'`, 'print header shown in print')
    await waitFor(`document.querySelector('[data-testid=gst-print-header]').textContent.includes('Prepared by Alton ERP for review and working purposes')
      && document.querySelector('[data-testid=gst-print-header]').textContent.includes('GSTIN 27AABCA1234A1Z5')`, 'print header content')
    await waitFor(`getComputedStyle([...document.querySelectorAll('button')].find((b) => b.textContent.includes('Export')).parentElement).display === 'none'`, 'controls hidden in print')
    assert(await evaluate(`[...document.querySelectorAll('style')].some((x) => x.textContent.includes('counter(page)') && x.textContent.includes('A4 landscape'))`), 'page numbering rule present')
    await evaluate(`(() => { window.scrollTo(0, 0); document.querySelectorAll('main, [data-scroll-container], .overflow-y-auto').forEach((e) => { e.scrollTop = 0 }); return true })()`)
    await waitFor(`document.querySelector('[data-testid=gst-print-header]').getBoundingClientRect().height > 0`, 'print header laid out')
    await screenshot('accounts-09-gst-close-print')
    await cdp('Emulation.setEmulatedMedia', { media: '' })
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
    Object.assign(GR, { filed: null, closed: false })
    await cdp('Emulation.setEmulatedMedia', { media: '' }).catch(() => {})
    await signOut().catch(() => {})
    await login('manager@test.invalid').catch(() => {})
  }
})

await step('Bank & cash (Phase 4): masked bank accounts with an audited reveal; new bank account; transfer draft and posting; statement import with column mapping and preview; manual match and a bank-charges adjustment; reconciliation saved at difference zero; payment-account assignment and the per-method policy; bank book', async () => {
  const PERMS = ['bank_accounts.read', 'bank_accounts.manage', 'cash_accounts.read', 'cash_accounts.manage', 'bank_reconciliation.read', 'bank_reconciliation.manage',
    'bank_reconciliation.approve', 'bank_transfers.create', 'bank_transfers.post', 'accounting_settings.manage', 'accounting_reports.read', 'accounts.read']
  USERS['manager@test.invalid'].permissions.push(...PERMS)
  const csvFile = path.join(outDir, 'bank-statement-test.csv')
  writeFileSync(csvFile, 'Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance\n05/11/26,NEFT-SBI INCL CHG,,"1,025.00",,"1,93,975.00"\n06/11/26,SMS CHARGES QTR,,59.00,,"1,93,916.00"\n')
  try {
    await goto('/')
    await waitFor(bodyHas('Smoke Tester'), 'signed-in layout')
    await signOut().catch(() => {})
    await login('manager@test.invalid')
    await waitFor(`location.pathname !== '/login'`, 'signed in')

    // Bank account master: masked number, reveal on request, new account.
    await goto('/accounts/bank-accounts')
    await waitFor(bodyHasAllCI('Bank Accounts', 'HDFC-CA', 'XXXXXXXXXX5678', 'HDFC0001234'), 'bank accounts (masked)')
    assert(!(await evaluate(bodyHas('50100012345678'))), 'full number shown without a request')
    await click('button[aria-label="Show the full number of HDFC-CA"]')
    await waitFor(bodyHas('50100012345678'), 'number revealed on request')
    await click('button', 'New bank account')
    await waitFor(bodyHas('Never enter internet-banking passwords'), 'new bank account dialog')
    await fill('#ma-code', 'sbi-ca')
    await fill('#ma-name', 'SBI Current')
    await click('#ma-ledger')
    await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('1240'))`, 'unlinked bank ledgers offered')
    assert(!(await evaluate(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('1230'))`)), 'a linked ledger offered again')
    await click('[role=option]', '1240')
    await fill('#ma-bank', 'State Bank of India')
    await fill('#ma-holder', 'Alton E2E')
    await fill('#ma-number', '3012 3456 789')
    await fill('#ma-ifsc', 'sbin0000456')
    await waitFor(bodyHas('Shown as XXXXXXX6789'), 'masked preview')
    await click('[role=dialog] button', 'Save')
    await waitFor(bodyHas('SBI-CA saved.'), 'bank account saved')
    const acc = rpcCalls('bank_cash_account_save').at(-1)?.body?.p_account
    assert(acc?.account_number === '30123456789' && acc.ifsc === 'SBIN0000456' && acc.account_code === 'SBI-CA' && acc.ledger_account_id === 'l-sbi', JSON.stringify(acc))

    // Transfer: draft, then post.
    await goto('/accounts/transfers')
    await waitFor(bodyHasAllCI('Bank & Cash Transfers', 'No transfers'), 'transfers page')
    await click('button', 'New transfer')
    await waitFor(bodyHas('creates one contra voucher'), 'transfer dialog')
    await fill('#tr-amount', '1000')
    await click('#tr-from')
    await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('HDFC-CA'))`, 'from options')
    await click('[role=option]', 'HDFC-CA')
    await click('#tr-to')
    await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('PETTY'))`, 'to options')
    await click('[role=option]', 'PETTY')
    await fill('#tr-ref', 'CASH WDL')
    await click('[role=dialog] button', 'Save draft')
    await waitFor(bodyHasAll('Draft TRF-000001 saved.', 'TRF-000001'), 'draft transfer')
    await click('button', 'Post')
    await waitFor(bodyHas('One contra voucher: Dr Petty Cash'), 'post confirmation')
    await click('[role=dialog] button', 'Post transfer')
    await waitFor(bodyHas('TRF-000001 posted as CTR/26-27/000001.'), 'transfer posted')

    // Statement import: mapping guessed from the header, preview, import.
    await goto('/accounts/bank-reconciliation/import?account=hdfc')
    await waitFor(`document.querySelector('input[type=file]')`, 'statement upload')
    const { root: doc } = await cdp('DOM.getDocument')
    const { nodeId } = await cdp('DOM.querySelector', { nodeId: doc.nodeId, selector: 'input[type=file]' })
    await cdp('DOM.setFileInputFiles', { nodeId, files: [csvFile] })
    await waitFor(bodyHasAll('2. Columns', 'header found on row 1'), 'column mapping')
    await click('button', 'Preview')
    await waitFor(bodyHasAll('3. Preview', '2 to import'), 'preview')
    const pre = rpcCalls('bank_statement_import').at(-1)?.body
    assert(pre?.p_commit === false && pre.p_rows.length === 2 && pre.p_rows[0].debit === '1025.00' && pre.p_rows[0].credit === '' && pre.p_rows[0].txn_date === '2026-11-05'
      && pre.p_rows[1].running_balance === '193916.00' && pre.p_file.content_base64.length > 20, JSON.stringify(pre?.p_rows))
    await click('button', 'Import 2 row(s)')
    await waitFor(bodyHasAll('Imported', 'bank-statement-test.csv'), 'imported, in the history')
    assert(rpcCalls('bank_statement_import').at(-1)?.body?.p_commit === true, 'not committed')

    // Reconciliation: one statement line against two ledger entries, then a charges adjustment, then save.
    await goto('/accounts/bank-reconciliation?account=hdfc')
    await waitFor(bodyHasAllCI('Books (posted ledger entries)', 'NEFT-SBI INCL CHG', 'SMS CHARGES QTR', 'Difference -1,036.00'), 'workspace and BRS')
    await click('button[aria-label="Select statement NEFT-SBI INCL CHG"]')
    await evaluate(`document.querySelectorAll('[data-testid=br-ledger] button[role=checkbox]').forEach((b) => b.click())`)
    await waitFor(`document.querySelector('[data-testid=br-selection]')?.innerText.includes('Difference 0.00')`, 'balanced selection')
    await click('button', 'Match selected')
    await waitFor(bodyHas('A manual match needs a reason'), 'match dialog')
    await fill('[role=dialog] textarea', 'transfer plus its charges')
    await click('[role=dialog] button', 'Match')
    await waitFor(bodyHas('Matched.'), 'matched')
    const mb = rpcCalls('bank_reconciliation_match').at(-1)?.body
    assert(mb?.p_items.length === 3 && mb.p_items.filter((i) => i.voucher_line_id).length === 2 && mb.p_reason === 'transfer plus its charges', JSON.stringify(mb))
    await click('button', 'Post adjustment')
    await waitFor(bodyHas('Dr the chosen expense ledger / Cr the bank ledger'), 'adjustment dialog')
    await click('#adj-ledger')
    await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('6600'))`, 'expense ledgers')
    await click('[role=option]', '6600')
    await click('[role=dialog] button', 'Post adjustment')
    await waitFor(bodyHas('Adjustment BNK/26-27/000001 posted and matched.'), 'adjustment posted')
    await waitFor(`document.querySelector('[data-testid=brs-difference]')?.innerText.includes('Difference 0.00')`, 'reconciled')
    await click('button', 'Save reconciliation')
    await waitFor(bodyHas('Reconciliation saved: complete.'), 'reconciliation saved')

    // Payment accounts: the per-method policy (Accounting Settings) and the assignment of a waiting payment.
    await goto('/accounts/settings?tab=rules')
    await waitFor(bodyHas('Bank / cash account per payment'), 'policy card')
    await click('button[aria-label="Payments by Cash: choose the account per payment"]')
    await waitFor(bodyHas('Choose per payment'), 'policy shown')
    assert(rpcCalls('bank_payment_policy_save').at(-1)?.body?.p_require_selection === true, 'policy not saved')
    await goto('/accounts/payment-accounts')
    await waitFor(bodyHasAllCI('Payment Accounts', 'SPAY-000009', 'Choose the account'), 'waiting payment')
    await click('button', 'Assign account')
    await waitFor(bodyHas('Record how you verified the account'), 'assign dialog')
    await click('#pa-account')
    await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('PETTY'))`, 'cash accounts only')
    assert(!(await evaluate(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('HDFC-CA'))`)), 'a bank account offered for a cash payment')
    await click('[role=option]', 'PETTY')
    await fill('#pa-reason', 'petty cash voucher PC-1')
    await click('[role=dialog] button', 'Assign')
    await waitFor(bodyHas('SPAY-000009 assigned.'), 'assigned')
    const asg = rpcCalls('bank_payment_assign').at(-1)?.body
    assert(asg?.p_account_id === 'petty' && asg.p_source_type === 'SUPPLIER_PAYMENT' && asg.p_reason === 'petty cash voucher PC-1', JSON.stringify(asg))

    // Bank book.
    await goto('/accounts/bank-book?account=hdfc')
    await waitFor(bodyHasAllCI('Bank Book', 'PMT/26-27/000009', 'CHQ-000123', 'Closing balance', '1,96,036.00 Dr', 'Unmatched'), 'bank book')
    await screenshot('accounts-06-bank-cash')
  } finally {
    USERS['manager@test.invalid'].permissions = USERS['manager@test.invalid'].permissions.filter((x) => !PERMS.includes(x))
    Object.assign(BK, { transfers: [], imports: [], matched: false, adjusted: false, policyCash: false })
    await signOut().catch(() => {})
    await login('manager@test.invalid').catch(() => {})
  }
})

await step('no console errors or uncaught exceptions', async () => {
  // The invalid-login attempt legitimately logs a 400 from the auth endpoint.
  // Failures simulated on purpose (failNext) are logged by the app's diagnostics ([ALTON ERP] ... failed) and are expected.
  const unexpected = consoleErrors.filter((e) => !/status of 400/.test(e) && !/^\[ALTON ERP\] .* failed/.test(e))
  assert(unexpected.length === 0, unexpected.join('\n'))
})

ws.close()
browser.kill()
// On Windows Edge can hand off to another process, so browser.kill() may leave the real browser running and
// holding the debugging port; the next run then fails. Stop every process using this run's own profile folder.
if (process.platform === 'win32') {
  const needle = path.basename(profileDir)
  spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' })
}
api.close()
app.close()
await sleep(500)
try {
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
} catch {
  // Browser may still hold profile files on Windows; temp folder is harmless.
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${failed === 0 ? '✓' : '✗'} UI smoke: ${results.length - failed} passed, ${failed} failed (screenshots in tests/ui-smoke/output)`)
process.exit(failed === 0 ? 0 : 1)
