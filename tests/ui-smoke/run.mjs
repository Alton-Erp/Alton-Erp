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
    submitted_at: NOW, reviewed_by: null, reviewed_at: null, review_note: null, posted_at: null, updated_at: NOW }],
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
  // bom_list plus the finished product's planning fields (migration 20261114090000).
  bom_list_v2: [bomRow('bom1', 1, 'APPROVED', VIEWER_ID), bomRow('bom2', 2, 'PENDING_APPROVAL', MANAGER_ID)]
    .map((b) => ({ ...b, tax_rate: 18, lead_time_days: 12, group_head: 'Sanitaryware', minimum_cover_days: 15, ean: '4006381333931' })),
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
const ERP_DEFAULTS = {
  'general.date_format': 'DD MMM YYYY', 'numbering.po_prefix': 'PO', 'numbering.grn_prefix': 'GRN', 'numbering.production_prefix': 'PRD', 'numbering.sales_order_prefix': 'SO',
  'product.auto_sku': true, 'product.sku_prefixes': { FINISHED_GOOD: 'FG', RAW_MATERIAL: 'RM', COMPONENT: 'CMP', SUBASSEMBLY: 'SUB', OUTSOURCED_COMPONENT: 'OSC', PACKAGING_MATERIAL: 'PKG', CONSUMABLE: 'CON', OTHER: 'ITM' },
  'product.units': ['PCS', 'NOS', 'SET', 'KG', 'LTR'], 'product.default_gst_rate': 18, 'product.hsn_codes': [{ code: '6910', description: 'Ceramic sanitary ware', gst_rate: 18 }],
  'inventory.adjustment_reasons': ['Damaged', 'Count correction'], 'purchase.default_payment_terms': 'DAYS_30', 'purchase.default_delivery_terms': null,
  'production.default_wastage_percent': 0, 'production.consumption_prefill': 'STANDARD', 'sales.default_payment_terms': null, 'sales.default_delivery_instructions': null,
  'sales.default_warehouse_id': null, 'import.date_order': 'DMY',
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
function filterRows(rows, params) {
  let out = rows
  for (const [key, value] of params) {
    if (['select', 'order', 'limit', 'offset', 'or', 'and'].includes(key)) continue
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
    const body = raw ? JSON.parse(raw) : null
    const single = (req.headers.accept ?? '').includes('vnd.pgrst.object')
    requests.push({ method: req.method, path: url.pathname, query: url.search, body })

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
        case 'product_kpis': {
          const active = products.filter((p) => p.status === 'ACTIVE')
          return send(res, 200, {
            active: active.length, in_house: active.filter((p) => p.default_source_type === 'IN_HOUSE').length,
            outsourced: active.filter((p) => p.default_source_type === 'OUTSOURCED').length,
            hybrid: active.filter((p) => p.default_source_type === 'HYBRID').length,
            inactive: products.filter((p) => p.status === 'INACTIVE').length, archived: 0, total: products.length,
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
            by_category: [{ category: 'Water Closets / Toilets', unit: 'PCS', on_hand: 140 }],
            by_warehouse: [{ warehouse_code: 'MAIN', warehouse_name: 'Mock main store', unit: 'PCS', on_hand: 140 }],
            first_transaction_at: NOW, last_transaction_at: NOW, warehouses: 1, pending_opening: 1, pending_adjustments: 1, pending_counts: 0,
            timezone: 'Asia/Kolkata', as_of: NOW,
          })
        case 'inventory_movement_trend':
          return send(res, 200, [{ bucket: TODAY, unit: 'PCS', quantity_in: 140, quantity_out: 0, transactions: 2 }])
        case 'inventory_policy_info':
          return send(res, 200, { segregation_of_duties: true, expiry_warning_days: 30, timezone: 'Asia/Kolkata', today: TODAY, negative_stock_allowed: false })
        case 'inventory_find_product_by_code': {
          const code = String(body.p_code ?? '').trim().toLowerCase()
          return send(res, 200, products.filter((p) => p.barcode === code || p.sku.toLowerCase() === code).map((p) => ({
            product_id: p.id, sku: p.sku, product_name: p.product_name, base_unit: p.base_unit, track_batches: p.track_batches, track_expiry: p.track_expiry,
            product_status: p.status, matched_on: p.barcode === code ? 'BARCODE' : 'SKU' })))
        }
        case 'inventory_post_receipt':
          return send(res, 200, { transaction_id: 't9', transaction_number: 'TXN-000009' })
        case 'inventory_submit_opening_stock':
          return send(res, 200, { ok: true, opening_batch_id: 'ob9', document_number: 'OS-000009', line_count: body.p_lines.length })
        case 'inventory_create_adjustment':
          return send(res, 200, { adjustment_id: 'a9', adjustment_number: 'ADJ-000009', status: body.p_submit ? 'PENDING_APPROVAL' : 'DRAFT' })
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
        case 'management_overview':
          return send(res, 200, MGMT_OVERVIEW(body.p_from, body.p_to))
        case 'module_dashboard':
          return send(res, 200, MODULE_DASHBOARDS[body.p_module] ?? null)
        case 'erp_settings_get':
          return send(res, 200, ERP_SETTINGS)
        case 'erp_settings_save': {
          if (body.p_settings?.['numbering.po_prefix'] === 'X') return send(res, 400, { code: 'P0001', message: 'Number prefixes are 2 to 5 capital letters (e.g. PO).' })
          Object.assign(ERP_SETTINGS.company, body.p_company ?? {})
          Object.assign(ERP_SETTINGS.settings, body.p_settings ?? {})
          return send(res, 200, ERP_SETTINGS)
        }
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
          return send(res, 200, [{ id: 'so1', sales_order_number: 'SO-000001', order_date: TODAY, customer_id: 'cu1', customer_name: 'Acme Ltd', customer_reference: 'ACME-77',
            requested_delivery_date: null, grand_total: 118000, status: 'READY_FOR_DISPATCH', order_status: 'CONFIRMED', created_at: NOW, units: [] }])
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
        case 'ledger_parties': {
          const rows = LEDGER_PARTIES.filter((p) => !body.p_party_id || p.party_id === body.p_party_id)
          return send(res, 200, rows)
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
          const isSup = body.p_party?.party_type !== 'CUSTOMER'
          if (isSup && !tables.suppliers.some((s) => s.id === 'sup-new')) tables.suppliers.push(supplierRow('sup-new', 'SUP-000003', { legal_name: name, state_code: body.p_party?.state_code ?? null }))
          return send(res, 200, { ok: true, party_id: 'pty-new', party_code: 'PTY-000009', party_type: body.p_party?.party_type,
            customer_id: isSup ? null : 'cu-new', customer_code: isSup ? null : 'CUS-000009', supplier_id: isSup ? 'sup-new' : null, supplier_code: isSup ? 'SUP-000003' : null })
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
          return send(res, 200, { receipt_id: 'gr2', receipt_number: 'GRN-000002', po_status: 'PARTIALLY_RECEIVED', transaction_numbers: ['TXN-000091'] })
        case 'goods_receipt_direct_post_refs':
        case 'goods_receipt_direct_post':
          return send(res, 200, { receipt_id: 'gr9', receipt_number: 'GRN-000009', transaction_numbers: ['TXN-000095'], unlinked: true,
            warnings: ['This receipt is not linked to a purchase order.', 'No supplier was recorded for this receipt.'] })
        case 'goods_receipt_correct_refs':
        case 'goods_receipt_correct':
          return send(res, 200, { receipt_id: 'gr10', receipt_number: 'GRN-000010', transaction_numbers: ['TXN-000097'], corrects_receipt_number: 'GRN-000001', reversal_numbers: ['TXN-000096'] })
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
      if (req.method === 'PATCH') return send(res, 204, undefined, { 'Content-Range': '*/1' })
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
  const rect = await evaluate(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter((e) => ${text ? `e.innerText.trim().includes(${JSON.stringify(text)})` : 'true'})
      .filter((e) => e.getBoundingClientRect().width > 0);
    const el = els[0];
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
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
async function step(name, fn) {
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
  assert(decodeURIComponent(searched.query).includes('or=(sku.ilike.%WC%'), `unexpected search query ${searched.query}`)
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
  await click('button[role=radio]', 'Hybrid')
  await waitFor(bodyHas('inventory receipts'), 'hybrid explanation')
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
{
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Alton product list (test)'],
    [],
    ['SKU', 'Product Name', 'Category', 'Product Type', 'Source Type', 'UOM', 'GST %', 'Selling Price'],
    ['IMP-1', 'Imported Basin', 'Wash Basins', 'Finished Good', 'In House', 'pcs', '18', '4600'],
    ['IMP-2', 'Imported Seat', '', 'Component', 'Outsourced', 'Nos', '', ''],
    ['imp-1', 'Duplicate of IMP-1', '', 'Finished Good', 'Outsourced', 'pcs', '', ''],
    ['IMP-3', 'Bad source', '', 'Finished Good', 'Factory', 'pcs', '', ''],
    ['MOCK-WC-1', 'Already exists', '', 'Finished Good', 'Outsourced', 'pcs', '', ''],
    ['IMP-4', 'Negative price', '', 'Finished Good', 'Outsourced', 'pcs', '', '-5'],
  ]), 'Products')
  writeFileSync(xlsxPath, Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'array' })))
}

await step('import: upload, detect header, map, validate without writing', async () => {
  await goto('/products/import')
  await waitFor(`document.querySelector('input[type=file]')`, 'file input')
  const { root: doc } = await cdp('DOM.getDocument')
  const { nodeId } = await cdp('DOM.querySelector', { nodeId: doc.nodeId, selector: 'input[type=file]' })
  await cdp('DOM.setFileInputFiles', { nodeId, files: [xlsxPath] })
  await waitFor(bodyHas('Column mapping'), 'mapping step')
  assert(await evaluate(`document.querySelector('#imp-header').value === '3'`), 'header row not detected as row 3')
  await screenshot('06-import-mapping')
  const before = writes().length
  await click('button', 'Validate')
  await waitFor(bodyHas('Row results'), 'review step')
  assert(writes().length === before, 'validation wrote to the database')
  assert(requests.some((r) => r.path === '/rest/v1/rpc/check_product_identifiers'), 'existing SKU lookup not performed')
  for (const text of ['Duplicate SKU in this file (first seen on row 4)', 'Source Type "Factory"', 'SKU already exists', 'Import 2 valid products']) {
    assert(await evaluate(bodyHas(text)), `missing "${text}"`)
  }
  await screenshot('07-import-review')
})

await step('import: confirm inserts only valid rows and reports a summary', async () => {
  const before = writes().length
  const requestsBefore = requests.length
  await click('button', 'Import 2 valid products')
  await waitFor(`document.querySelector('[role=alertdialog]')`, 'confirm')
  assert(writes().length === before, 'imported before confirmation')
  await click('[role=alertdialog] button', 'Import products')
  await waitFor(bodyHas('Import finished'), 'summary')
  const inserted = writes().slice(before).flatMap((r) => (Array.isArray(r.body) ? r.body : [r.body]))
  assert(inserted.length === 2, `expected 2 inserted rows, got ${inserted.length}`)
  assert(inserted.map((r) => r.sku).sort().join() === 'IMP-1,IMP-2', 'wrong rows inserted')
  assert(inserted[0].category_id === 'c1', 'category not resolved')
  assert(requests.some((r) => r.path === '/rest/v1/rpc/log_product_import'), 'import not logged')
  assert(!requests.slice(requestsBefore).some((r) => /stock|inventory/.test(r.path)), 'import touched stock')
  assert(await evaluate(bodyHas('2 created and 0 updated, of 6 rows')), 'summary text')
  await screenshot('08-import-summary')
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
  assert(csv.includes('SKU,Product Name,Category,Product Type,Source Type,Unit,HSN Code,GST Rate,MRP,Selling Price,Standard Purchase Cost,Standard Manufacturing Cost'), 'CSV header')
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
  await click('button[aria-label="Show details of MOCK-WC-1"]')
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

await step('opening stock: manual lines are submitted for approval (not posted)', async () => {
  await goto('/inventory/opening-stock')
  await waitFor(bodyHas('OS-000002'), 'opening list')
  await click('button', 'Enter opening stock')
  await waitFor(`document.querySelector('#os-product')`, 'entry dialog')
  await fill('#os-product', 'MOCK')
  await waitFor(`[...document.querySelectorAll('[role=option]')].some((o) => o.innerText.includes('MOCK-WC-1'))`, 'search results')
  await click('[role=option]', 'MOCK-WC-1')
  await choose('#os-src', 'In-House')
  await fill('#os-qty', '7')
  await fill('#os-cost', '450')
  await click('[role=dialog] button', 'Add line')
  await waitFor(bodyHas('Review 1 line(s)'), 'line added')
  await click('[role=dialog] button', 'Review 1 line(s)')
  await click('[role=dialog] button', 'Submit for approval')
  await waitFor(bodyHas('OS-000009 submitted'), 'submitted')
  const b = rpcCalls('inventory_submit_opening_stock').at(-1).body
  assert(b.p_source === 'MANUAL' && b.p_lines.length === 1, JSON.stringify(b))
  assert(b.p_lines[0].quantity === 7 && b.p_lines[0].source_type === 'IN_HOUSE' && b.p_lines[0].unit_cost === 450 && b.p_lines[0].location_id === 'l1', JSON.stringify(b.p_lines[0]))
  assert(!requests.some((r) => r.path.includes('review_opening')), 'auto-approved')
})

const csvPath = path.join(outDir, 'opening-test.csv')
writeFileSync(csvPath, 'SKU,Warehouse,Location,Source,Qty,Unit Cost\nMOCK-WC-1,MAIN,BIN-1,In House,3,450\nNOPE-1,MAIN,,In House,2,\nMOCK-WC-1,MAIN,BIN-1,Factory,1,\n')

await step('opening stock import: rejected rows listed, only accepted rows staged after confirmation', async () => {
  await goto('/inventory/opening-stock/import')
  await waitFor(`document.querySelector('input[type=file]')`, 'upload')
  const { root: doc } = await cdp('DOM.getDocument')
  const { nodeId } = await cdp('DOM.querySelector', { nodeId: doc.nodeId, selector: 'input[type=file]' })
  await cdp('DOM.setFileInputFiles', { nodeId, files: [csvPath] })
  await waitFor(bodyHas('Column mapping'), 'mapping')
  const before = rpcCalls('inventory_submit_opening_stock').length
  await click('button', 'Validate rows')
  await waitFor(bodyHas('Row results'), 'review')
  for (const text of ['SKU "NOPE-1" was not found', 'Source "Factory" is not recognised']) assert(await evaluate(bodyHas(text)), `missing "${text}"`)
  assert(rpcCalls('inventory_submit_opening_stock').length === before, 'validation wrote data')
  await screenshot('14-opening-import-review')
  await click('button', 'Stage 1 accepted row(s) for approval')
  await waitFor(`document.querySelector('[role=alertdialog]')`, 'confirm')
  await click('[role=alertdialog] button', 'Stage for approval')
  await waitFor(bodyHas('OS-000009 staged'), 'staged')
  const b = rpcCalls('inventory_submit_opening_stock').at(-1).body
  assert(b.p_source === 'IMPORT' && b.p_lines.length === 1 && b.p_lines[0].line_no === 2 && b.p_lines[0].location_id === 'l2', JSON.stringify(b))
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
  await goto('/production/boms')
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
  await waitFor(bodyHasAll('Sales Dashboard', 'Total Sales Orders', 'Orders Created Today', 'Orders This Month', 'Total Sales Order Value', 'Pending Orders',
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
  await waitFor(bodyHasAll('Invoice Dashboard', 'Total invoices', 'Created today', 'Issued this month', 'Invoice value', 'Taxable value', 'GST', 'Amount received', 'Outstanding',
    'Overdue', 'Partially paid', 'Fully paid', 'Drafts', 'Cancelled'), 'KPI labels')
  await waitFor(bodyHasAll('2,54,380.50', 'GST summary', '18%', 'Overdue invoices', 'Monthly trend', 'INV/26-27/0001', 'Nothing is filed'), 'figures')
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
  const metrics = ['Total stock', 'Manufactured stock', 'Outsourced stock', 'Purchase orders', 'Pending GRNs', 'Production orders', 'Sales orders', 'Invoiced sales', 'Outstanding payments']
  await waitFor(bodyHasAll('Management Dashboard', ...metrics), 'metrics')
  const card = (id) => evaluate(`document.querySelector('[data-testid=${id}]')?.innerText ?? ''`)
  // Stock split from inventory_overview (in-house = manufactured, outsourced); never invented.
  assert((await card('kpi-total-stock')).includes('140 PCS'), await card('kpi-total-stock'))
  assert((await card('kpi-manufactured-stock')).includes('100 PCS'), await card('kpi-manufactured-stock'))
  assert((await card('kpi-outsourced-stock')).includes('40 PCS'), await card('kpi-outsourced-stock'))
  assert(/\b2\b/.test(await card('kpi-purchase-orders')) && (await card('kpi-purchase-orders')).includes('1 open'), await card('kpi-purchase-orders'))
  assert((await card('kpi-pending-grns')).includes('₹210.00 still to receive'), await card('kpi-pending-grns'))
  assert((await card('kpi-sales-orders')).includes('₹31,860.00'), await card('kpi-sales-orders'))
  assert((await card('kpi-invoiced-sales')).includes('₹14,160.00'), await card('kpi-invoiced-sales'))
  assert((await card('kpi-outstanding')).includes('₹4,460.00 due to suppliers'), await card('kpi-outstanding'))
  for (const t of ['Sales orders booked', 'Production output', 'Stock movement', 'Stock by source', 'Invoiced vs collected', 'Purchases ordered vs received', 'Needs attention', 'Low stock', 'Customer balances']) {
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
  await waitFor(bodyHas('Outstanding payments'), 'mobile dashboard')
  assert(await noHorizontalScroll(), 'mobile: dashboard scrolls horizontally')
  await screenshot('v2-management-dashboard-mobile')
  await cdp('Emulation.clearDeviceMetricsOverride')
})

await step('global search: records (product, sales order) and modules; choosing a record opens it', async () => {
  await goto('/')
  await fill('input[aria-label="Search records and modules"]', 'wc')
  await waitFor(bodyHasAll('MOCK-WC-1 — Mock Closet 1', 'SO-000001 — Acme Ltd'), 'record results')
  assert(rpcCalls('global_search').at(-1).body.p_term === 'wc', 'search term not sent')
  await evaluate(`[...document.querySelectorAll('[role=option]')].find((o) => o.innerText.includes('SO-000001')).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await waitFor(`location.pathname === '/sales/orders/so1'`, 'opened the sales order')
})

await step('module dashboards: products, ledger, purchase orders and goods received', async () => {
  const pages = [
    ['/products/dashboard', ['Product Master Dashboard', 'Total Products', 'Finished Goods', 'Raw Materials', 'Components', 'Outsourced Parts', 'Products Without BOM', 'Recently Added', 'Low Stock Products', 'MOCK-WC-2']],
    ['/ledger/dashboard', ['Ledger Dashboard', 'Total Customers', 'Total Suppliers', 'Customer and Supplier', 'Customer Receivables', 'Supplier Payables', 'Outstanding Balances', 'Top customers', 'Top suppliers']],
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
  assert(paths.length >= 40 && paths.length <= 60, `expected the V2 navigation, found ${paths.length}`)
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
  const groups = await evaluate(`[...document.querySelectorAll('aside nav > div')].map((d) => (d.querySelector('button[aria-expanded], p')?.innerText ?? '').trim().toLowerCase())`)
  assert(groups.join('|') === ['Management Dashboard', 'Product Master & BOM', 'Inventory Management', 'Purchase & GRN', 'Production & Outsourcing', 'Sales & Orders', 'Billing & Invoicing', 'Ledger', 'Reports & Settings'].join('|').toLowerCase(), groups.join('|'))
  assert(!(await evaluate(bodyHas('Not built'))), '"Not built" label shown')
  // Removed legacy modules are not reachable; merged pages redirect to their V2 page.
  for (const p of ['/analytics', '/amazon', '/customer-pos', '/marketplace-orders', '/activity', '/reconciliation', '/admin/approvals', '/admin/barcodes', '/admin/documents', '/admin/system-health', '/admin/user-activity',
    '/inventory/adjustments', '/inventory/counts', '/inventory/batches', '/inventory/reports', '/production/outsourcing', '/production/outsourced-receipts',
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
  await click('button', 'New supplier')
  await waitFor(`!!document.querySelector('#qa-supplier-name')`, 'quick add dialog')
  await fill('#qa-supplier-name', 'Shree Clay Works')
  await click('[role=dialog] button', 'Save supplier')
  await waitFor(bodyHas('This party may already exist'), 'duplicate warning')
  assert(!(rpcCalls('party_save').at(-1).body.p_confirm_duplicates), 'first save must not confirm duplicates')
  await click('[role=dialog] button', 'It is a different party')
  await waitFor(`!document.querySelector('#qa-supplier-name')`, 'dialog closed')
  const save = rpcCalls('party_save').at(-1).body
  assert(save.p_party_id === null && save.p_party.party_type === 'SUPPLIER' && save.p_party.party_name === 'Shree Clay Works' && save.p_confirm_duplicates === true, JSON.stringify(save))
  await sleep(800)
  await screenshot('quick-add-supplier')
  const shown = await evaluate(`document.querySelector('#po-supplier').innerText`)
  tables.suppliers = tables.suppliers.filter((s) => s.id !== 'sup-new')
  assert(String(shown).includes('SUP-000003'), `new supplier not selected; supplier box shows "${shown}"; option requests: ${rpcCalls('purchase_supplier_options').length}`)
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
  await goto('/goods-receipts')
  await waitFor(bodyHas('Receive without PO'), 'register')
  await click('button', 'Receive without PO')
  await waitFor(`!!document.querySelector('#dr-prod-0')`, 'direct receipt dialog')
  assert(await evaluate(bodyHas('This is an unlinked receipt')), 'unlinked warning missing')
  await click('[role=dialog] button[type=submit]')
  await waitFor(bodyHas('Add at least one product received.'), 'validation')
  assert(poCalls('goods_receipt_direct_post_refs').length === 0, 'invalid receipt sent')
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
  await waitFor(bodyHasAll('Management Dashboard', 'Total stock', 'Outstanding payments'), 'dashboard for viewer')
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
  assert(lastQuery('/rest/v1/purchase_order_list_v2').includes('status=in.(APPROVED,SENT,PARTIALLY_RECEIVED)'), lastQuery('/rest/v1/purchase_order_list_v2'))
  await waitFor(`${bodyHasAll('Open POs', 'Purchase Dashboard', 'PO-000003', 'Rule: status in Approved, Sent, Partially received')} && !document.querySelector('[data-testid=drill-table]').innerText.includes('PO-000001')`, 'records and rule')
  assert(await evaluate(`[...document.querySelectorAll('nav[aria-label=Breadcrumb] a')].some((a) => a.innerText.includes('Purchase Dashboard') && a.getAttribute('href').includes('from=2026-11-01'))`), 'breadcrumb back to the dashboard with its period')
  await screenshot('131-drill-page')
})

await step('Drill-down 2: search, sort and columns run on the server; a record opens and Back returns to the same list', async () => {
  await fill('input[aria-label="Search records"]', 'PO-0000')
  await waitFor(`location.search.includes('q=PO-0000')`, 'search in the address')
  for (let i = 0; i < 30 && !lastQuery('/rest/v1/purchase_order_list_v2').includes('po_number.ilike.%PO-0000%'); i++) await sleep(100)
  assert(lastQuery('/rest/v1/purchase_order_list_v2').includes('or=(po_number.ilike.%PO-0000%'), lastQuery('/rest/v1/purchase_order_list_v2'))
  await click('[data-testid=drill-table] th button', 'Value')
  await waitFor(`location.search.includes('sort=grand_total')`, 'sorted')
  for (let i = 0; i < 30 && !lastQuery('/rest/v1/purchase_order_list_v2').includes('order=grand_total.asc'); i++) await sleep(100)
  assert(lastQuery('/rest/v1/purchase_order_list_v2').includes('order=grand_total.asc'), 'sort not sent to the server')
  await click('button', 'Columns')
  await waitFor(bodyHas('Pending value'), 'column picker')
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
  assert(lastQuery('/rest/v1/purchase_order_list_v2').includes('supplier_name=eq.Shree Clay Works Pvt Ltd') && lastQuery('/rest/v1/purchase_order_list_v2').includes('po_date=gte.2026-11-01'), lastQuery('/rest/v1/purchase_order_list_v2'))
  await evaluate('history.back()')
  await waitFor(`location.pathname === '/purchase-orders/dashboard'`, 'back')
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
    ['/ledger/dashboard', 'Customer Receivables', 'ledger.receivables']]) {
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
  assert(lastQuery('/rest/v1/sales_invoice_list').includes('display_status=eq.OVERDUE') && lastQuery('/rest/v1/sales_invoice_list').includes('invoice_date=gte.2026-10-01'), lastQuery('/rest/v1/sales_invoice_list'))
  await click('button[aria-label^="Remove Payment"]')
  await waitFor(`!location.search.includes('payment=') && !document.querySelector('[data-testid=drill-chip]')`, 'chip removed')
  await goto('/sales/dashboard')
  await waitFor(`!!${kpiLink('Pending Orders')}`, 'sales dashboard')
  await click('a[data-drill=kpi]', 'Pending Orders')
  await waitFor(`location.pathname === '/drilldown/sales.pending' && !!document.querySelector('[data-testid=drill-count]')`, 'sales records (status computed by the database)')
  assert(rpcCalls('sales_orders_v2_list').length > 0, 'sales list not read from the database function')
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
