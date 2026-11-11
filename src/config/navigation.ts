import type { LucideIcon } from 'lucide-react'
import {
  ArrowLeftRight,
  LayoutTemplate,
  Ban,
  BellRing,
  BookUser,
  Boxes,
  Building2,
  CalendarRange,
  ChartColumn,
  ClipboardCheck,
  ClipboardList,
  Factory,
  FileBarChart,
  FileMinus,
  FilePlus,
  FilePlus2,
  FileStack,
  HandCoins,
  Hourglass,
  LayoutDashboard,
  ListTodo,
  Lock,
  Network,
  Package,
  PackageCheck,
  PackageMinus,
  Percent,
  Receipt,
  ScrollText,
  Settings2,
  ShoppingCart,
  SlidersHorizontal,
  Table2,
  UserCog,
  Users,
  Wallet,
  Warehouse,
} from 'lucide-react'

import type { PermissionCode } from '@/auth/permissions'

/**
 * Alton Manufacturing ERP V2 navigation: only the nine approved sections.
 * Every entry opens a working page backed by the V2 database functions.
 */
export type NavKey =
  // 1. Management Dashboard
  | 'dashboard'
  // 2. Product Master & BOM
  | 'products-dashboard'
  | 'products'
  | 'production-boms'
  | 'production-bom-templates'
  // 3. Inventory Management
  | 'inventory'
  | 'inventory-register'
  | 'inventory-movements'
  | 'inventory-reservations'
  | 'inventory-warehouses'
  | 'inventory-alerts'
  | 'inventory-adjustments'
  // 4. Purchase & GRN
  | 'purchase-dashboard'
  | 'purchase-orders'
  | 'goods-receipts'
  | 'grn-dashboard'
  // 5. Production & Outsourcing
  | 'production'
  | 'production-orders'
  | 'production-planning'
  | 'production-consumption'
  | 'production-receipts'
  | 'production-reports'
  // 6. Sales & Orders
  | 'sales-dashboard'
  | 'sales-orders'
  | 'sales-backorders'
  | 'sales-cancellation'
  // 7. Billing & Invoicing
  | 'billing-dashboard'
  | 'billing-invoices'
  | 'billing-create'
  | 'billing-register'
  | 'billing-payments'
  | 'billing-allocations'
  | 'billing-receivables'
  | 'billing-ageing'
  | 'billing-credit-notes'
  | 'billing-debit-notes'
  | 'billing-statements'
  | 'billing-tax'
  | 'billing-reports'
  | 'billing-settings'
  // 8. Ledger
  | 'ledger-dashboard'
  | 'ledger'
  | 'ledger-customers'
  | 'ledger-suppliers'
  // 9. Reports & Settings
  | 'reports'
  | 'admin-erp-settings'
  | 'users'
  | 'admin-bulk'
  | 'audit-logs'

export interface NavItem {
  key: NavKey
  title: string
  path: string
  icon: LucideIcon
  /** Subtitle shown in the page header and used by global search. */
  description: string
  group: NavGroupId
  keywords?: string[]
}

export type NavGroupId = 'overview' | 'products' | 'inventory' | 'purchase' | 'production' | 'sales' | 'billing' | 'ledger' | 'reports'

export const NAV_GROUPS: { id: NavGroupId; label: string }[] = [
  { id: 'overview', label: 'Management Dashboard' },
  { id: 'products', label: 'Product Master & BOM' },
  { id: 'inventory', label: 'Inventory Management' },
  { id: 'purchase', label: 'Purchase & GRN' },
  { id: 'production', label: 'Production & Outsourcing' },
  { id: 'sales', label: 'Sales & Orders' },
  { id: 'billing', label: 'Billing & Invoicing' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'reports', label: 'Reports & Settings' },
]

export const NAV_ITEMS: NavItem[] = [
  // 1. Management Dashboard
  {
    key: 'dashboard',
    title: 'Management Dashboard',
    path: '/',
    icon: LayoutDashboard,
    group: 'overview',
    description: 'Stock, purchasing, production, sales, invoicing and money owed for the selected period.',
    keywords: ['home', 'overview', 'kpi', 'dashboard', 'management'],
  },

  // 2. Product Master & BOM
  {
    key: 'products-dashboard',
    title: 'Product Dashboard',
    path: '/products/dashboard',
    icon: LayoutDashboard,
    group: 'products',
    description: 'Products by type, products without a BOM, recent and low-stock products.',
    keywords: ['product', 'dashboard', 'bom'],
  },
  {
    key: 'products',
    title: 'Product Master',
    path: '/products',
    icon: Package,
    group: 'products',
    description: 'Finished goods, raw materials, components and packaging: SKUs, categories, units, HSN, GST and prices.',
    keywords: ['sku', 'catalogue', 'item', 'category', 'import'],
  },
  {
    key: 'production-boms',
    title: 'Bill of Materials (BOM)',
    path: '/production/boms',
    icon: Network,
    group: 'products',
    description: 'Raw materials, components and packaging needed per unit of a finished product, with versions.',
    keywords: ['bom', 'recipe', 'components', 'materials'],
  },
  {
    key: 'production-bom-templates',
    title: 'BOM Templates',
    path: '/production/bom-templates',
    icon: LayoutTemplate,
    group: 'products',
    description: 'Reusable component lists for creating new finished products; create similar products, clone and compare BOMs.',
    keywords: ['bom', 'template', 'clone', 'similar product', 'copy', 'compare'],
  },

  // 3. Inventory Management
  {
    key: 'inventory',
    title: 'Inventory Overview',
    path: '/inventory',
    icon: Boxes,
    group: 'inventory',
    description: 'Current stock position, movements and inventory health.',
    keywords: ['stock', 'inventory', 'kpi', 'dashboard'],
  },
  {
    key: 'inventory-register',
    title: 'Stock Register',
    path: '/inventory/stock',
    icon: Table2,
    group: 'inventory',
    description: 'On-hand, reserved and available stock by product, source, warehouse, location and batch.',
    keywords: ['stock', 'on hand', 'available', 'barcode', 'manufactured', 'outsourced'],
  },
  {
    key: 'inventory-movements',
    title: 'Stock Movements',
    path: '/inventory/movements',
    icon: ArrowLeftRight,
    group: 'inventory',
    description: 'The stock ledger: receipts, issues, transfers, adjustments and reversals.',
    keywords: ['ledger', 'receipt', 'issue', 'transfer', 'grn'],
  },
  {
    key: 'inventory-reservations',
    title: 'Stock Reservations',
    path: '/inventory/reservations',
    icon: Lock,
    group: 'inventory',
    description: 'Stock reserved for sales and production orders but not yet issued.',
    keywords: ['reserve', 'allocation'],
  },
  {
    key: 'inventory-warehouses',
    title: 'Warehouses & Locations',
    path: '/inventory/warehouses',
    icon: Warehouse,
    group: 'inventory',
    description: 'Warehouses, zones, racks, shelves and bins.',
    keywords: ['warehouse', 'bin', 'rack', 'location'],
  },
  {
    key: 'inventory-alerts',
    title: 'Low Stock Alerts',
    path: '/inventory/alerts',
    icon: BellRing,
    group: 'inventory',
    description: 'Low, out-of-stock and expiring inventory.',
    keywords: ['alert', 'low stock', 'expiry', 'reorder'],
  },
  {
    key: 'inventory-adjustments',
    title: 'Stock Adjustments',
    path: '/inventory/adjustments',
    icon: SlidersHorizontal,
    group: 'inventory',
    description: 'Physical stock reconciliation: count, difference, reason, approval and posting.',
    keywords: ['adjustment', 'physical count', 'reconciliation', 'damage', 'loss', 'found', 'write-off'],
  },

  // 4. Purchase Orders & GRN
  {
    key: 'purchase-dashboard',
    title: 'Purchase Dashboard',
    path: '/purchase-orders/dashboard',
    icon: LayoutDashboard,
    group: 'purchase',
    description: 'Open, partially and fully received POs, pending value, overdue deliveries and top suppliers.',
    keywords: ['purchase', 'po', 'dashboard'],
  },
  {
    key: 'purchase-orders',
    title: 'Purchase Orders',
    path: '/purchase-orders',
    icon: ClipboardList,
    group: 'purchase',
    description: 'Raise and follow up purchase orders placed with suppliers.',
    keywords: ['po', 'purchase', 'buying', 'vendor', 'supplier'],
  },
  {
    key: 'goods-receipts',
    title: 'Goods Received (GRN)',
    path: '/goods-receipts',
    icon: PackageCheck,
    group: 'purchase',
    description: 'Goods received against purchase orders or without one; corrections and reversals.',
    keywords: ['grn', 'goods receipt', 'inward', 'challan', 'unlinked', 'receive'],
  },
  {
    key: 'grn-dashboard',
    title: 'GRN Dashboard',
    path: '/goods-receipts/dashboard',
    icon: LayoutDashboard,
    group: 'purchase',
    description: 'GRNs today and this month, pending receipts, rejected goods and unlinked GRNs.',
    keywords: ['grn', 'goods received', 'dashboard', 'pending'],
  },

  // 5. Production & Outsourcing
  {
    key: 'production',
    title: 'Production Dashboard',
    path: '/production',
    icon: Factory,
    group: 'production',
    description: 'Production orders, output, material consumption, shortages and recent activity.',
    keywords: ['production', 'factory', 'manufacturing', 'kpi', 'dashboard', 'new production', 'import production'],
  },
  {
    key: 'production-orders',
    title: 'Production Orders',
    path: '/production/orders',
    icon: ClipboardCheck,
    group: 'production',
    description: 'In-house production orders from draft through material issue, output and completion.',
    keywords: ['work order', 'production order', 'job'],
  },
  {
    key: 'production-planning',
    title: 'Production Planning',
    path: '/production/planning',
    icon: CalendarRange,
    group: 'production',
    description: 'Check material requirements and shortages before anything is reserved or issued.',
    keywords: ['plan', 'mrp', 'requirement', 'shortage'],
  },
  {
    key: 'production-consumption',
    title: 'Material Consumption',
    path: '/production/consumption',
    icon: PackageMinus,
    group: 'production',
    description: 'Raw materials issued to production orders, with lot, location and ledger reference.',
    keywords: ['issue', 'consumption', 'raw material'],
  },
  {
    key: 'production-receipts',
    title: 'Finished Goods Receipts',
    path: '/production/receipts',
    icon: PackageCheck,
    group: 'production',
    description: 'Good, rejected and scrap output recorded against production orders.',
    keywords: ['output', 'finished goods', 'fg receipt', 'rejection', 'scrap'],
  },
  {
    key: 'production-reports',
    title: 'Production Reports',
    path: '/production/reports',
    icon: FileBarChart,
    group: 'production',
    description: 'Production, consumption, outsourcing, traceability and cost reports.',
    keywords: ['report', 'traceability', 'variance', 'cost'],
  },

  // 6. Sales Orders & Fulfilment
  {
    key: 'sales-dashboard',
    title: 'Sales Dashboard',
    path: '/sales/dashboard',
    icon: LayoutDashboard,
    group: 'sales',
    description: 'Sales orders, value, reserved stock, production required, shortages and fulfilment.',
    keywords: ['sales', 'dashboard', 'orders', 'reservation', 'shortage', 'production required'],
  },
  {
    key: 'sales-orders',
    title: 'Sales Orders',
    path: '/sales/orders',
    icon: ShoppingCart,
    group: 'sales',
    description: 'Sales orders with automatic stock reservation and their fulfilment status.',
    keywords: ['so', 'sales order', 'import'],
  },
  {
    key: 'sales-backorders',
    title: 'Partial Fulfilment',
    path: '/sales/backorders',
    icon: ListTodo,
    group: 'sales',
    description: 'Outstanding and backordered quantities per order line, with reasons and expected dates.',
    keywords: ['backorder', 'partial', 'remaining', 'shortage'],
  },
  {
    key: 'sales-cancellation',
    title: 'Order Cancellation',
    path: '/sales/cancellation',
    icon: Ban,
    group: 'sales',
    description: 'Review what cancelling an order affects, then cancel it and release its reservations.',
    keywords: ['cancel', 'release'],
  },

  // 7. Billing & Invoicing
  {
    key: 'billing-dashboard',
    title: 'Invoice Dashboard',
    path: '/billing/dashboard',
    icon: LayoutDashboard,
    group: 'billing',
    description: 'Invoices, value, GST, received, outstanding and overdue, with the monthly trend and the GST summary.',
    keywords: ['invoice', 'dashboard', 'gst', 'outstanding', 'overdue', 'payments'],
  },
  {
    key: 'billing-invoices',
    title: 'Sales Invoices',
    path: '/billing/invoices',
    icon: Receipt,
    group: 'billing',
    description: 'Draft, proforma and issued invoices with their payment state.',
    keywords: ['invoice', 'gst', 'bill', 'draft'],
  },
  {
    key: 'billing-create',
    title: 'Create Invoice',
    path: '/billing/invoices/new',
    icon: FilePlus,
    group: 'billing',
    description: 'Create an invoice manually, from a sales order (full or partial) or from dispatches; proforma invoices too.',
    keywords: ['new invoice', 'manual invoice', 'sales order', 'proforma', 'dispatch', 'billing'],
  },
  {
    key: 'billing-register',
    title: 'Invoice Register',
    path: '/billing/register',
    icon: Table2,
    group: 'billing',
    description: 'All issued and cancelled invoices by financial year, customer and status.',
    keywords: ['register', 'invoice list', 'financial year', 'import'],
  },
  {
    key: 'billing-payments',
    title: 'Customer Payments',
    path: '/billing/payments',
    icon: Wallet,
    group: 'billing',
    description: 'Record receipts, see allocations and reverse receipts with a reason.',
    keywords: ['receipt', 'payment', 'collection', 'upi', 'cheque'],
  },
  {
    key: 'billing-allocations',
    title: 'Payment Allocation',
    path: '/billing/allocations',
    icon: ArrowLeftRight,
    group: 'billing',
    description: 'Allocate unallocated receipts to a customer’s open invoices.',
    keywords: ['allocate', 'unallocated', 'on account', 'advance'],
  },
  {
    key: 'billing-receivables',
    title: 'Outstanding Receivables',
    path: '/billing/receivables',
    icon: HandCoins,
    group: 'billing',
    description: 'Open invoice balances as of a reporting date.',
    keywords: ['outstanding', 'receivable', 'balance due'],
  },
  {
    key: 'billing-ageing',
    title: 'Receivables Ageing',
    path: '/billing/ageing',
    icon: Hourglass,
    group: 'billing',
    description: 'Outstanding balances by customer and days overdue.',
    keywords: ['ageing', 'aging', 'overdue', 'buckets'],
  },
  {
    key: 'billing-credit-notes',
    title: 'Credit Notes',
    path: '/billing/credit-notes',
    icon: FileMinus,
    group: 'billing',
    description: 'Credits against issued invoices for returns, quality issues and agreed corrections.',
    keywords: ['credit note', 'cn', 'return'],
  },
  {
    key: 'billing-debit-notes',
    title: 'Debit Notes',
    path: '/billing/debit-notes',
    icon: FilePlus2,
    group: 'billing',
    description: 'Additional amounts charged against issued invoices.',
    keywords: ['debit note', 'dn', 'additional charge'],
  },
  {
    key: 'billing-statements',
    title: 'Customer Statements',
    path: '/billing/statements',
    icon: ScrollText,
    group: 'billing',
    description: 'Printable statement of account with running balance.',
    keywords: ['statement', 'ledger', 'account'],
  },
  {
    key: 'billing-tax',
    title: 'GST Summary',
    path: '/billing/tax-summary',
    icon: Percent,
    group: 'billing',
    description: 'GST rate, CGST/SGST/IGST and HSN summaries (management reports, not GST returns).',
    keywords: ['gst', 'hsn', 'cgst', 'igst', 'tax'],
  },
  {
    key: 'billing-reports',
    title: 'Billing Reports',
    path: '/billing/reports',
    icon: FileBarChart,
    group: 'billing',
    description: 'Invoices, collections, outstanding, notes, unallocated receipts and cancellations.',
    keywords: ['report', 'collections', 'export'],
  },
  {
    key: 'billing-settings',
    title: 'Invoice Settings',
    path: '/billing/settings',
    icon: Settings2,
    group: 'billing',
    description: 'Numbering, financial year, tax policy, payment terms, bank details and footer.',
    keywords: ['numbering', 'prefix', 'financial year', 'bank'],
  },

  // 8. Ledger
  {
    key: 'ledger-dashboard',
    title: 'Ledger Dashboard',
    path: '/ledger/dashboard',
    icon: LayoutDashboard,
    group: 'ledger',
    description: 'Customers, suppliers, receivables, payables and top parties.',
    keywords: ['ledger', 'dashboard', 'receivable', 'payable'],
  },
  {
    key: 'ledger',
    title: 'Customer & Supplier Ledger',
    path: '/ledger',
    icon: BookUser,
    group: 'ledger',
    description: 'Customers and suppliers in one place: details, outstanding balances and transaction history.',
    keywords: ['party', 'ledger', 'customer', 'supplier', 'vendor', 'receivable', 'payable', 'outstanding', 'gstin'],
  },
  {
    key: 'ledger-customers',
    title: 'Customer Ledger',
    path: '/ledger/customers',
    icon: Users,
    group: 'ledger',
    description: 'Customers (including parties that are also suppliers) with receivables and overdue amounts. Open a customer for its transactions and running balance.',
    keywords: ['customer', 'receivable', 'debtor', 'outstanding', 'statement'],
  },
  {
    key: 'ledger-suppliers',
    title: 'Supplier Ledger',
    path: '/ledger/suppliers',
    icon: Building2,
    group: 'ledger',
    description: 'Suppliers (including parties that are also customers) with payables from goods received less payments. Open a supplier to record a payment.',
    keywords: ['supplier', 'vendor', 'payable', 'creditor', 'payment'],
  },

  // 9. Reports & Settings
  {
    key: 'reports',
    title: 'Reports Centre',
    path: '/reports',
    icon: ChartColumn,
    group: 'reports',
    description: 'Twenty reports across products, stock, purchase, production, sales and invoicing, with Excel export.',
    keywords: ['analytics', 'export', 'report'],
  },
  {
    key: 'admin-erp-settings',
    title: 'ERP Settings',
    path: '/admin/erp-settings',
    icon: SlidersHorizontal,
    group: 'reports',
    description: 'Company, numbering, products, stock, purchase, production, sales, invoices, imports and backups.',
    keywords: ['settings', 'configuration', 'preferences', 'company', 'gstin', 'logo'],
  },
  {
    key: 'users',
    title: 'Users & Roles',
    path: '/users',
    icon: UserCog,
    group: 'reports',
    description: 'Sign-in accounts, roles and access permissions.',
    keywords: ['roles', 'permissions', 'staff', 'login'],
  },
  {
    key: 'admin-bulk',
    title: 'Import History',
    path: '/admin/bulk-operations',
    icon: FileStack,
    group: 'reports',
    description: 'Every Excel import run with its rows, rejected rows and error reports.',
    keywords: ['import', 'bulk', 'errors', 'excel'],
  },
  {
    key: 'audit-logs',
    title: 'Audit Log',
    path: '/audit-logs',
    icon: ScrollText,
    group: 'reports',
    description: 'A record of every change made in the ERP.',
    keywords: ['history', 'activity', 'audit'],
  },
]

/**
 * Permission required to see each page (null = any authorized user).
 * Used for sidebar visibility and route guards — the database enforces the
 * same permissions independently through RLS.
 */
export const NAV_PERMISSIONS: Record<NavKey, PermissionCode | null> = {
  dashboard: 'dashboard.read',
  'products-dashboard': 'products.read',
  products: 'products.read',
  'production-boms': 'production_bom.read',
  'production-bom-templates': 'production_bom.read',
  inventory: 'inventory.read',
  'inventory-register': 'inventory.read',
  'inventory-movements': 'inventory.read',
  'inventory-reservations': 'inventory.read',
  'inventory-warehouses': 'inventory.read',
  'inventory-alerts': 'inventory.read',
  'inventory-adjustments': 'inventory.read',
  'purchase-dashboard': 'purchases.read',
  'purchase-orders': 'purchases.read',
  'goods-receipts': 'purchases.read',
  'grn-dashboard': 'purchases.read',
  production: 'manufacturing.read',
  'production-orders': 'manufacturing.read',
  'production-planning': 'production_plan.create',
  'production-consumption': 'manufacturing.read',
  'production-receipts': 'manufacturing.read',
  'production-reports': 'production_reports.read',
  'sales-dashboard': 'sales_orders.read',
  'sales-orders': 'sales_orders.read',
  'sales-backorders': 'sales_orders.read',
  'sales-cancellation': 'sales_orders.read',
  'billing-dashboard': 'invoices.read',
  'billing-invoices': 'invoices.read',
  'billing-create': 'invoices.create',
  'billing-register': 'invoices.read',
  'billing-payments': 'payments.read',
  'billing-allocations': 'payments.read',
  'billing-receivables': 'billing_reports.read',
  'billing-ageing': 'billing_reports.read',
  'billing-credit-notes': 'invoices.read',
  'billing-debit-notes': 'invoices.read',
  'billing-statements': 'billing_reports.read',
  'billing-tax': 'billing_reports.read',
  'billing-reports': 'billing_reports.read',
  'billing-settings': 'billing_settings.manage',
  'ledger-dashboard': 'ledger.read',
  ledger: 'ledger.read',
  'ledger-customers': 'ledger.read',
  'ledger-suppliers': 'ledger.read',
  reports: 'reports.read',
  'admin-erp-settings': 'settings.manage',
  users: 'users.manage',
  'admin-bulk': 'bulk_operations.read',
  'audit-logs': 'audit_logs.read',
}

export function findNavItemByPath(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.path === pathname)
}

export function getNavItem(key: NavKey): NavItem {
  const item = NAV_ITEMS.find((i) => i.key === key)
  if (!item) throw new Error(`Unknown navigation key: ${key}`)
  return item
}

export function getNavGroupLabel(id: NavGroupId): string {
  return NAV_GROUPS.find((g) => g.id === id)?.label ?? ''
}
