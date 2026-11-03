import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

import type { PermissionCode } from '@/auth/permissions'
import type { NavKey } from '@/config/navigation'

/**
 * One page component per navigation entry. Pages are lazy-loaded so heavy
 * dependencies (e.g. charts) only download when needed.
 * The Record type guarantees every sidebar entry has a route.
 */
export const PAGE_COMPONENTS: Record<NavKey, LazyExoticComponent<ComponentType>> = {
  dashboard: lazy(() => import('@/pages/management-overview-page')),
  'products-dashboard': lazy(() => import('@/pages/products/products-dashboard-page')),
  products: lazy(() => import('@/pages/products-page')),
  'production-boms': lazy(() => import('@/pages/production/boms-page')),
  inventory: lazy(() => import('@/pages/inventory/inventory-overview-page')),
  'inventory-register': lazy(() => import('@/pages/inventory/stock-register-page')),
  'inventory-movements': lazy(() => import('@/pages/inventory/stock-movements-page')),
  'inventory-reservations': lazy(() => import('@/pages/inventory/reservations-page')),
  'inventory-warehouses': lazy(() => import('@/pages/inventory/warehouses-page')),
  'inventory-alerts': lazy(() => import('@/pages/inventory/low-stock-alerts-page')),
  'purchase-dashboard': lazy(() => import('@/pages/purchasing/purchase-dashboard-page')),
  'purchase-orders': lazy(() => import('@/pages/purchase-orders-page')),
  'goods-receipts': lazy(() => import('@/pages/goods-receipts-page')),
  'grn-dashboard': lazy(() => import('@/pages/purchasing/grn-dashboard-page')),
  production: lazy(() => import('@/pages/production/production-dashboard-page')),
  'production-orders': lazy(() => import('@/pages/production/production-orders-page')),
  'production-planning': lazy(() => import('@/pages/production/production-planning-page')),
  'production-consumption': lazy(() => import('@/pages/production/material-consumption-page')),
  'production-receipts': lazy(() => import('@/pages/production/finished-goods-receipts-page')),
  'production-reports': lazy(() => import('@/pages/production/production-reports-page')),
  'sales-dashboard': lazy(() => import('@/pages/sales/sales-dashboard-page')),
  'sales-orders': lazy(() => import('@/pages/sales/sales-orders-page')),
  'sales-backorders': lazy(() => import('@/pages/sales/backorders-page')),
  'sales-cancellation': lazy(() => import('@/pages/sales/cancellation-page')),
  'billing-dashboard': lazy(() => import('@/pages/billing/invoice-dashboard-page')),
  'billing-invoices': lazy(() => import('@/pages/billing/invoices-page')),
  'billing-create': lazy(() => import('@/pages/billing/invoice-entry-page')),
  'billing-register': lazy(() => import('@/pages/billing/invoice-register-page')),
  'billing-payments': lazy(() => import('@/pages/billing/payments-page')),
  'billing-allocations': lazy(() => import('@/pages/billing/allocations-page')),
  'billing-receivables': lazy(() => import('@/pages/billing/receivables-page')),
  'billing-ageing': lazy(() => import('@/pages/billing/ageing-page')),
  'billing-credit-notes': lazy(() => import('@/pages/billing/credit-notes-page')),
  'billing-debit-notes': lazy(() => import('@/pages/billing/debit-notes-page')),
  'billing-statements': lazy(() => import('@/pages/billing/statements-page')),
  'billing-tax': lazy(() => import('@/pages/billing/tax-summary-page')),
  'billing-reports': lazy(() => import('@/pages/billing/billing-reports-page')),
  'billing-settings': lazy(() => import('@/pages/billing/invoice-settings-page')),
  'ledger-dashboard': lazy(() => import('@/pages/ledger/ledger-dashboard-page')),
  ledger: lazy(() => import('@/pages/ledger-page')),
  'ledger-customers': lazy(() => import('@/pages/ledger/customer-ledger-page')),
  'ledger-suppliers': lazy(() => import('@/pages/ledger/supplier-ledger-page')),
  reports: lazy(() => import('@/pages/reports/reports-centre-page')),
  'admin-erp-settings': lazy(() => import('@/pages/admin/erp-settings-hub-page')),
  users: lazy(() => import('@/pages/users-page')),
  'admin-bulk': lazy(() => import('@/pages/admin/bulk-operations-page')),
  'audit-logs': lazy(() => import('@/pages/audit-logs-page')),
}

export const NotFoundPage = lazy(() => import('@/pages/not-found-page'))

/**
 * Pages below a sidebar entry (not in the navigation). Each declares the
 * permission its route requires (null = any signed-in user); static paths win over `:productId`.
 */
export const SUB_ROUTES: { path: string; permission: PermissionCode | null; component: LazyExoticComponent<ComponentType> }[] = [
  { path: '/reports/view/:reportKey', permission: 'reports.read', component: lazy(() => import('@/pages/reports/report-view-page')) },
  { path: '/products/new', permission: 'products.create', component: lazy(() => import('@/pages/products/product-form-page')) },
  { path: '/products/import', permission: 'products.import', component: lazy(() => import('@/pages/products/product-import-page')) },
  { path: '/products/categories', permission: 'products.read', component: lazy(() => import('@/pages/products/product-categories-page')) },
  { path: '/products/:productId', permission: 'products.read', component: lazy(() => import('@/pages/products/product-detail-page')) },
  { path: '/products/:productId/edit', permission: 'products.update', component: lazy(() => import('@/pages/products/product-form-page')) },
  { path: '/inventory/stock/:productId', permission: 'inventory.read', component: lazy(() => import('@/pages/inventory/product-stock-page')) },
  { path: '/inventory/opening-stock', permission: 'inventory.read', component: lazy(() => import('@/pages/inventory/opening-stock-page')) },
  { path: '/inventory/whole-piece-audit', permission: 'inventory_reconciliation.run', component: lazy(() => import('@/pages/inventory/whole-piece-audit-page')) },
  { path: '/inventory/opening-stock/import', permission: 'inventory_opening.create', component: lazy(() => import('@/pages/inventory/opening-stock-import-page')) },
  { path: '/production/boms/new', permission: 'production_bom.create', component: lazy(() => import('@/pages/production/bom-editor-page')) },
  { path: '/production/boms/import', permission: 'production_bom.create', component: lazy(() => import('@/pages/production/bom-import-page')) },
  { path: '/production/boms/:bomId', permission: 'production_bom.read', component: lazy(() => import('@/pages/production/bom-editor-page')) },
  { path: '/production/new', permission: 'production_order.create', component: lazy(() => import('@/pages/production/production-entry-page')) },
  { path: '/production/import', permission: 'production_order.create', component: lazy(() => import('@/pages/production/production-import-page')) },
  { path: '/production/orders/:orderId', permission: 'manufacturing.read', component: lazy(() => import('@/pages/production/production-order-detail-page')) },
  // Edit: the database decides who may edit which order (own orders with production_order.create, any with production_order.update).
  { path: '/production/orders/:orderId/edit', permission: 'manufacturing.read', component: lazy(() => import('@/pages/production/production-entry-page')) },
  { path: '/purchase-orders/new', permission: 'purchase_order.create', component: lazy(() => import('@/pages/purchasing/po-form-page')) },
  { path: '/purchase-orders/:poId', permission: 'purchases.read', component: lazy(() => import('@/pages/purchasing/po-detail-page')) },
  // Edit page: the database decides who may edit which draft (own drafts with purchase_order.create, any with purchase_order.update).
  { path: '/purchase-orders/:poId/edit', permission: 'purchases.read', component: lazy(() => import('@/pages/purchasing/po-form-page')) },
  { path: '/purchase-orders/:poId/print', permission: 'purchase_order.export', component: lazy(() => import('@/pages/purchasing/po-print-page')) },
  { path: '/goods-receipts/:receiptId', permission: 'purchases.read', component: lazy(() => import('@/pages/purchasing/goods-receipt-detail-page')) },
  { path: '/goods-receipts/:receiptId/print', permission: 'purchases.read', component: lazy(() => import('@/pages/purchasing/grn-print-page')) },
  { path: '/sales/orders/new', permission: 'sales_orders.create', component: lazy(() => import('@/pages/sales/sales-order-entry-page')) },
  { path: '/sales/orders/import', permission: 'sales_orders.create', component: lazy(() => import('@/pages/sales/sales-import-page')) },
  { path: '/sales/orders/:soId', permission: 'sales_orders.read', component: lazy(() => import('@/pages/sales/sales-order-v2-page')) },
  { path: '/sales/orders/:soId/edit', permission: 'sales_orders.update', component: lazy(() => import('@/pages/sales/sales-order-entry-page')) },
  { path: '/ledger/new', permission: 'ledger.read', component: lazy(() => import('@/pages/ledger/party-form-page')) },
  { path: '/ledger/:partyId', permission: 'ledger.read', component: lazy(() => import('@/pages/ledger/party-detail-page')) },
  { path: '/ledger/:partyId/edit', permission: 'ledger.read', component: lazy(() => import('@/pages/ledger/party-form-page')) },
  { path: '/billing/invoices/import', permission: 'invoices.create', component: lazy(() => import('@/pages/billing/invoice-import-page')) },
  { path: '/billing/invoices/:invoiceId', permission: 'invoices.read', component: lazy(() => import('@/pages/billing/invoice-detail-page')) },
  { path: '/billing/invoices/:invoiceId/edit', permission: 'invoices.create', component: lazy(() => import('@/pages/billing/invoice-entry-page')) },
  { path: '/billing/invoices/:invoiceId/print', permission: 'invoices.read', component: lazy(() => import('@/pages/billing/invoice-print-page')) },
  { path: '/billing/notes/:noteId', permission: 'invoices.read', component: lazy(() => import('@/pages/billing/note-detail-page')) },
  { path: '/billing/notes/:noteId/print', permission: 'invoices.read', component: lazy(() => import('@/pages/billing/note-print-page')) },
  // Opened from the bell in the top bar (import results and system messages).
  { path: '/notifications', permission: null, component: lazy(() => import('@/pages/notifications-page')) },
]

/**
 * Former addresses of pages that were merged into a V2 page; old bookmarks land on the replacement.
 * Addresses of removed legacy modules (analytics, Amazon, customer POs, marketplace, approvals, …) show "Page not found".
 */
export const REDIRECTS: { from: string; to: string }[] = [
  { from: '/dashboard/inventory', to: '/inventory' },
  { from: '/production/analytics', to: '/production' },
  { from: '/sales', to: '/sales/dashboard' },
  { from: '/sales-orders', to: '/sales/orders' },
  { from: '/billing', to: '/billing/dashboard' },
  { from: '/payments', to: '/billing/payments' },
  { from: '/customers', to: '/ledger/customers' },
  { from: '/suppliers', to: '/ledger/suppliers' },
  { from: '/settings', to: '/admin/erp-settings?tab=company' },
  { from: '/reports/modules', to: '/reports' },
]

// Public authentication pages (outside the protected layout).
export const LoginPage = lazy(() => import('@/pages/auth/login-page'))
export const ForgotPasswordPage = lazy(() => import('@/pages/auth/forgot-password-page'))
export const ResetPasswordPage = lazy(() => import('@/pages/auth/reset-password-page'))
export const AcceptInvitationPage = lazy(() => import('@/pages/auth/accept-invitation-page'))
